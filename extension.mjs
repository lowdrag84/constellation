// Constellation — MCP Profile Management for GitHub Copilot CLI
// Controls which MCP servers are active per task domain.
// Layer 1: profile_switch (full replacement, user-only)
// Layer 2: svr_load/svr_unload (single-MCP, additive/subtractive, pipeline + user)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

// ── Paths ────────────────────────────────────────────────────────────────────
const HOME = process.env.USERPROFILE || process.env.HOME;
const PROFILES_PATH = join(HOME, ".copilot", "profiles.yaml");
const SETTINGS_PATH = join(HOME, ".copilot", "settings.json");
const MCP_JSON_PATH = join(HOME, ".copilot", "mcp-config.json");
const MANIFEST_PATH = join(HOME, ".copilot", "mcp-manifest.yaml");

// ── Minimal YAML parser (profiles.yaml is simple key-value + lists) ──────────
//
// FORMAT CONSTRAINTS (see docs/yaml-format.md for full details):
//   - All string values MUST be double-quoted: description: "my value"
//   - Backslashes in paths are JSON-escaped: "C:\\Users\\me\\project"
//   - Empty arrays use inline syntax: mcp_servers: []
//   - Null values use bare keyword: working_dir: null
//   - Comments (#) and blank lines are ignored
//   - Profile names must be 2-char indented: "  my-profile:"
//   - List items must be indented with "  - " under their parent key

function _quoteYamlString(value) {
    return JSON.stringify(String(value));
}

function _parseYamlScalar(rawValue) {
    const value = rawValue.trim();
    if (value === "null") return null;
    if (value === "[]") return [];
    if (value.startsWith('"') && value.endsWith('"')) {
        try {
            return JSON.parse(value);
        } catch {
            return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        }
    }
    return value;
}

function _uniqueStrings(values) {
    return Array.from(new Set((values || []).filter(value => typeof value === "string" && value.length > 0)));
}

function _sameStringSet(left, right) {
    const a = _uniqueStrings(left);
    const b = _uniqueStrings(right);
    return a.length === b.length && a.every(value => b.includes(value));
}

function _formatList(values) {
    return values.length > 0 ? values.join(", ") : "none";
}

function _readMcpJsonServers() {
    if (!existsSync(MCP_JSON_PATH)) return [];
    try {
        const data = JSON.parse(readFileSync(MCP_JSON_PATH, "utf-8"));
        return Object.keys(data.mcpServers || {});
    } catch {
        return [];
    }
}

function _appendYamlList(lines, indent, items, { quote = true } = {}) {
    if (!items || items.length === 0) {
        lines.push(`${indent}[]`);
        return;
    }
    for (const item of items) {
        lines.push(`${indent}- ${quote ? _quoteYamlString(item) : item}`);
    }
}

function parseProfilesYaml(text) {
    const result = { all_mcp_servers: [], always_on: { skills: [] }, profiles: {} };
    const lines = text.split("\n");
    let currentSection = null;
    let currentProfile = null;
    let currentField = null;
    let currentSubField = null;

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");

        if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

        // Top-level keys
        if (/^all_mcp_servers:/.test(line)) { currentSection = "all_mcp_servers"; currentProfile = null; continue; }
        if (/^always_on:/.test(line)) { currentSection = "always_on"; currentProfile = null; continue; }
        if (/^profiles:/.test(line)) { currentSection = "profiles"; currentProfile = null; continue; }

        if (currentSection === "all_mcp_servers") {
            const m = line.match(/^\s+-\s+(.+)/);
            if (m) result.all_mcp_servers.push(m[1].trim());
        } else if (currentSection === "always_on") {
            if (/^\s+skills:/.test(line)) { currentSubField = "skills"; continue; }
            if (/^\s+instructions:/.test(line)) { currentSubField = "instructions"; continue; }
            if (currentSubField) {
                const m = line.match(/^\s+-\s+"?([^"]+)"?/);
                if (m) {
                    if (!result.always_on[currentSubField]) result.always_on[currentSubField] = [];
                    result.always_on[currentSubField].push(m[1].trim());
                }
            }
        } else if (currentSection === "profiles") {
            const profileMatch = line.match(/^  (\S[\w-]+):/);
            if (profileMatch) {
                currentProfile = profileMatch[1];
                result.profiles[currentProfile] = {
                    description: "", mcp_servers: [], plugins: [],
                    working_dir: null, hint: ""
                };
                currentField = null;
                continue;
            }

            if (!currentProfile) continue;
            const prof = result.profiles[currentProfile];

            const descMatch = line.match(/^\s+description:\s+(".*")\s*$/);
            if (descMatch) { prof.description = _parseYamlScalar(descMatch[1]); continue; }

            const hintMatch = line.match(/^\s+hint:\s+(".*")\s*$/);
            if (hintMatch) { prof.hint = _parseYamlScalar(hintMatch[1]); continue; }

            const wdMatch = line.match(/^\s+working_dir:\s+(".*")\s*$/);
            if (wdMatch) { prof.working_dir = _parseYamlScalar(wdMatch[1]); continue; }
            if (/^\s+working_dir:\s+null/.test(line)) { prof.working_dir = null; continue; }

            const listFieldMatch = line.match(/^\s+(mcp_servers|plugins):/);
            if (listFieldMatch) {
                currentField = listFieldMatch[1];
                if (/\[\]/.test(line)) { prof[currentField] = []; currentField = null; }
                continue;
            }

            if (currentField) {
                const itemMatch = line.match(/^\s+-\s+(.+)/);
                if (itemMatch) {
                    prof[currentField].push(itemMatch[1].trim().replace(/^"|"$/g, ""));
                } else {
                    currentField = null;
                }
            }
        }
    }

    return result;
}

// ── YAML serializers ─────────────────────────────────────────────────────────

function serializeProfilesYaml(data) {
    const allServers = _uniqueStrings(data?.all_mcp_servers || []);
    const persistentSet = new Set(_readMcpJsonServers());
    const persistentServers = allServers.filter(server => persistentSet.has(server));
    const agencyServers = allServers.filter(server => !persistentSet.has(server));
    const skills = _uniqueStrings(data?.always_on?.skills || []);
    const instructions = _uniqueStrings(data?.always_on?.instructions || []);
    const lines = [
        "# Constellation — Profile Definitions",
        "# The single source of truth for Copilot CLI configuration profiles.",
        "# Each profile controls which MCP servers are active per task domain.",
        "# Layer 1: profile_switch (full replacement, user-only)",
        "# Layer 2: svr_load/svr_unload (single-MCP, additive/subtractive, pipeline + user)",
        "",
        `# All MCP servers registered for à la carte loading (${allServers.length} total)`,
        "all_mcp_servers:",
        "  # Persistent MCPs (defined in mcp-config.json)",
    ];

    if (persistentServers.length > 0) {
        _appendYamlList(lines, "  ", persistentServers, { quote: false });
    }
    lines.push("  # On-demand MCPs (loaded via svr_load)");
    if (agencyServers.length > 0) {
        _appendYamlList(lines, "  ", agencyServers, { quote: false });
    }

    lines.push(
        "",
        "# Always-on components (never disabled regardless of profile)",
        "always_on:",
        "  skills:"
    );
    _appendYamlList(lines, "    ", skills);
    lines.push("  instructions:");
    _appendYamlList(lines, "    ", instructions);
    lines.push("", "profiles:");

    for (const [name, profile] of Object.entries(data?.profiles || {})) {
        lines.push(`  ${name}:`);
        lines.push(`    description: ${_quoteYamlString(profile.description ?? "")}`);

        const mcpServers = _uniqueStrings(profile.mcp_servers || []);
        if (mcpServers.length === 0) {
            lines.push("    mcp_servers: []");
        } else {
            lines.push("    mcp_servers:");
            _appendYamlList(lines, "      ", mcpServers);
        }

        const plugins = _uniqueStrings(profile.plugins || []);
        if (plugins.length === 0) {
            lines.push("    plugins: []");
        } else {
            lines.push("    plugins:");
            _appendYamlList(lines, "      ", plugins);
        }

        lines.push(profile.working_dir == null
            ? "    working_dir: null"
            : `    working_dir: ${_quoteYamlString(profile.working_dir)}`);
        lines.push(`    hint: ${_quoteYamlString(profile.hint ?? "")}`);
        lines.push("");
    }

    if (lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n") + "\n";
}

// ── MCP manifest parser / serializer ─────────────────────────────────────────

function parseMcpManifest(text) {
    const result = { servers: {} };
    const lines = text.split("\n");
    let inServers = false;
    let currentServer = null;
    let currentField = null;

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

        if (/^servers:/.test(line)) {
            inServers = true;
            currentServer = null;
            currentField = null;
            continue;
        }

        if (!inServers) continue;

        const serverMatch = line.match(/^  ([a-z][\w-]*):\s*$/);
        if (serverMatch) {
            currentServer = serverMatch[1];
            result.servers[currentServer] = {
                description: "",
                capabilities: [],
                use_when: "",
            };
            currentField = null;
            continue;
        }

        if (!currentServer) continue;
        const server = result.servers[currentServer];

        const scalarMatch = line.match(/^    (description|use_when|note):\s*(.+?)\s*$/);
        if (scalarMatch) {
            server[scalarMatch[1]] = _parseYamlScalar(scalarMatch[2]);
            currentField = null;
            continue;
        }

        if (/^    capabilities:\s*\[\]\s*$/.test(line)) {
            server.capabilities = [];
            currentField = null;
            continue;
        }

        if (/^    capabilities:\s*$/.test(line)) {
            server.capabilities = [];
            currentField = "capabilities";
            continue;
        }

        if (currentField === "capabilities") {
            const itemMatch = line.match(/^      -\s+(.+?)\s*$/);
            if (itemMatch) {
                server.capabilities.push(_parseYamlScalar(itemMatch[1]));
                continue;
            }
            currentField = null;
        }
    }

    return result;
}

function _appendManifestServer(lines, name, server) {
    lines.push(`  ${name}:`);
    lines.push(`    description: ${_quoteYamlString(server.description ?? "")}`);

    const capabilities = _uniqueStrings(server.capabilities || []);
    if (capabilities.length === 0) {
        lines.push("    capabilities: []");
    } else {
        lines.push("    capabilities:");
        _appendYamlList(lines, "      ", capabilities);
    }

    lines.push(`    use_when: ${_quoteYamlString(server.use_when ?? "")}`);
    if (server.note != null && server.note !== "") {
        lines.push(`    note: ${_quoteYamlString(server.note)}`);
    }
    lines.push("");
}

function serializeMcpManifest(data) {
    const servers = data?.servers || {};
    const serverNames = Object.keys(servers);
    const persistentSet = new Set(_readMcpJsonServers());
    const persistentServers = serverNames.filter(name => persistentSet.has(name));
    const onDemandServers = serverNames.filter(name => !persistentSet.has(name));
    const lines = [
        "# MCP Capability Manifest",
        "# Read this file to determine which MCP server to load for a given task.",
        "# Agents/LLMs consult this BEFORE calling svr_load so they know which",
        "# MCP provides the tools they need — even when the MCP is not yet active.",
        "#",
        "# Source of truth for MCP server names: profiles.yaml → all_mcp_servers",
        "# This file adds capability descriptions only — it does NOT control loading.",
        "",
        "servers:",
        "  # ── Persistent MCPs (defined in mcp-config.json) ──────────────────────────",
        "",
    ];

    for (const name of persistentServers) {
        _appendManifestServer(lines, name, servers[name]);
    }

    lines.push("  # ── On-demand MCPs (loaded via svr_load) ──────────────────────────────", "");
    for (const name of onDemandServers) {
        _appendManifestServer(lines, name, servers[name]);
    }

    if (lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n") + "\n";
}

// ── File I/O helpers ─────────────────────────────────────────────────────────

function loadProfiles() {
    if (!existsSync(PROFILES_PATH)) return null;
    const text = readFileSync(PROFILES_PATH, "utf-8");
    return parseProfilesYaml(text);
}

function saveProfiles(data) {
    writeFileSync(PROFILES_PATH, serializeProfilesYaml(data), "utf-8");
}

function loadMcpManifest() {
    if (!existsSync(MANIFEST_PATH)) return { servers: {} };
    const text = readFileSync(MANIFEST_PATH, "utf-8");
    return parseMcpManifest(text);
}

function saveMcpManifest(data) {
    writeFileSync(MANIFEST_PATH, serializeMcpManifest(data), "utf-8");
}

function readSettings() {
    if (!existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
}

function writeSettings(settings) {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

// ── Input validation helpers ─────────────────────────────────────────────────

function _validateName(name) {
    if (typeof name !== "string") return "Name must be a string.";
    if (name.length < 2 || name.length > 40) return "Name must be 2-40 characters long.";
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return "Name must match /^[a-z][a-z0-9-]*$/.";
    return null;
}

function _validateYamlString(str) {
    if (typeof str !== "string") return "Value must be a string.";
    if (str.length >= 500) return "Value must be shorter than 500 characters.";
    if (/[\r\n]/.test(str)) return "Value cannot contain newlines.";
    if (/[\x00-\x1F\x7F]/.test(str)) return "Value cannot contain control characters.";
    return null;
}

function _validateStringArray(values, label, { allowEmpty = true, useNameValidator = false } = {}) {
    if (values == null) return { ok: true, values: [] };
    if (!Array.isArray(values)) return { ok: false, error: `${label} must be an array.` };
    if (!allowEmpty && values.length === 0) return { ok: false, error: `${label} cannot be empty.` };

    const normalized = [];
    for (const value of values) {
        if (typeof value !== "string") return { ok: false, error: `${label} must contain only strings.` };
        const validationError = useNameValidator ? _validateName(value) : _validateYamlString(value);
        if (validationError) return { ok: false, error: `${label}: ${validationError}` };
        normalized.push(value);
    }

    return { ok: true, values: _uniqueStrings(normalized) };
}

function _validateMcpNames(values, allMcps, label) {
    const parsed = _validateStringArray(values, label, { useNameValidator: true });
    if (!parsed.ok) return parsed;

    for (const name of parsed.values) {
        if (!allMcps.includes(name)) {
            return { ok: false, error: `${label}: unknown MCP server "${name}".` };
        }
    }

    return parsed;
}

// ── Profile state detection ──────────────────────────────────────────────────

function _detectProfileState(profiles, settings) {
    const allMcps = _uniqueStrings(profiles?.all_mcp_servers || []);
    const disabledSet = new Set((settings?.disabledMcpServers || []).filter(server => allMcps.includes(server)));
    const disabled = allMcps.filter(server => disabledSet.has(server));
    const enabled = allMcps.filter(server => !disabledSet.has(server));

    let baseProfile = settings?.activeProfile || null;
    if (baseProfile && !profiles?.profiles?.[baseProfile]) baseProfile = null;

    let exactProfile = null;
    let isDrifted = false;
    let extraMcps = [];
    let missingMcps = [];

    if (baseProfile) {
        const baseMcps = _uniqueStrings(profiles.profiles[baseProfile].mcp_servers || []);
        if (_sameStringSet(baseMcps, enabled)) {
            exactProfile = baseProfile;
        } else {
            isDrifted = true;
            extraMcps = enabled.filter(server => !baseMcps.includes(server));
            missingMcps = baseMcps.filter(server => !enabled.includes(server));
        }
    }

    const ambiguousMatches = Object.entries(profiles?.profiles || {})
        .filter(([, profile]) => _sameStringSet(profile.mcp_servers || [], enabled))
        .map(([name]) => name);

    if (!exactProfile) {
        if (baseProfile && ambiguousMatches.includes(baseProfile)) {
            exactProfile = baseProfile;
        } else if (ambiguousMatches.length === 1) {
            exactProfile = ambiguousMatches[0];
        }
    }

    return {
        enabled,
        disabled,
        exactProfile,
        baseProfile,
        isDrifted,
        extraMcps,
        missingMcps,
        ambiguousMatches,
    };
}

function _reconcileActiveProfile(profiles) {
    const settings = readSettings();
    const state = _detectProfileState(profiles, settings);
    let nextActiveProfile = settings.activeProfile ?? null;

    if (state.exactProfile) {
        nextActiveProfile = state.exactProfile;
    } else if (!(state.baseProfile && state.ambiguousMatches.includes(state.baseProfile))) {
        nextActiveProfile = null;
    }

    settings.activeProfile = nextActiveProfile;
    writeSettings(settings);
    return { ...state, activeProfile: nextActiveProfile };
}

// ── First-run bootstrap ──────────────────────────────────────────────────────

function _bootstrapIfNeeded() {
    if (existsSync(PROFILES_PATH)) return null;

    // Scan mcp-config.json for existing servers
    const mcpServers = _readMcpJsonServers();

    const data = {
        all_mcp_servers: mcpServers,
        always_on: { skills: [], instructions: [] },
        profiles: {
            lean: {
                description: "Minimal footprint for general tasks and quick questions",
                mcp_servers: [],
                plugins: [],
                working_dir: null,
                hint: "Quick questions, general coding, starting a session",
            },
        },
    };

    saveProfiles(data);

    // Create mcp-manifest.yaml with placeholder entries if it doesn't exist
    if (!existsSync(MANIFEST_PATH)) {
        const manifest = { servers: {} };
        for (const server of mcpServers) {
            manifest.servers[server] = {
                description: `${server} MCP server`,
                capabilities: ["See server documentation"],
                use_when: `User needs ${server} capabilities`,
            };
        }
        saveMcpManifest(manifest);
    }

    return {
        mcpCount: mcpServers.length,
        mcpServers,
    };
}

// ── Centralized MCP toggle helpers ───────────────────────────────────────────

async function toggleMcpEnable(serverName, rpc) {
    try {
        await rpc.mcp.enable({ serverName });
        const settings = readSettings();
        settings.disabledMcpServers = (settings.disabledMcpServers || []).filter(server => server !== serverName);
        writeSettings(settings);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function toggleMcpDisable(serverName, rpc) {
    try {
        await rpc.mcp.disable({ serverName });
        const settings = readSettings();
        const disabled = settings.disabledMcpServers || [];
        settings.disabledMcpServers = Array.from(new Set([...disabled, serverName]));
        writeSettings(settings);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ── Profile switching logic ──────────────────────────────────────────────────

function applyProfile(profileName, profiles) {
    const profile = profiles.profiles[profileName];
    if (!profile) {
        return {
            ok: false,
            message: `Unknown profile: "${profileName}". Use profile_list to see available profiles.`,
        };
    }

    const allMcps = _uniqueStrings(profiles.all_mcp_servers || []);
    const enabledMcps = _uniqueStrings(profile.mcp_servers || []).filter(server => allMcps.includes(server));
    const disabledMcps = allMcps.filter(server => !enabledMcps.includes(server));

    const settings = readSettings();
    const previousDisabled = (settings.disabledMcpServers || []).filter(server => allMcps.includes(server));
    const unsealed = enabledMcps.filter(server => previousDisabled.includes(server));
    const sealed = disabledMcps.filter(server => !previousDisabled.includes(server));

    let report = `🔄 Profile shift → \`${profileName}\`\n`;
    report += `   ${profile.description}\n`;
    report += `   MCPs enabled: ${_formatList(enabledMcps)}\n`;
    report += `   MCPs disabled: ${_formatList(disabledMcps)}\n`;
    if (unsealed.length > 0) report += `   Unsealed: ${unsealed.join(", ")}\n`;
    if (sealed.length > 0) report += `   Sealed: ${sealed.join(", ")}\n`;
    if ((profile.plugins || []).length > 0) report += `   Plugins: ${profile.plugins.join(", ")}\n`;
    if (profile.working_dir) report += `   Working dir: ${profile.working_dir}\n`;

    return {
        ok: true,
        message: report.trimEnd(),
        needsReload: unsealed.length > 0 || sealed.length > 0,
        workingDir: profile.working_dir,
        enableMcps: unsealed,
        disableMcps: sealed,
        finalDisabled: disabledMcps,
        finalEnabled: enabledMcps,
        profileName,
    };
}

// ── Extension entry point ────────────────────────────────────────────────────
const session = await joinSession({
    hooks: {
        onSessionStart: async () => {
            // Bootstrap on first run
            const bootstrapResult = _bootstrapIfNeeded();

            const profiles = loadProfiles();
            if (!profiles) return;

            const state = _detectProfileState(profiles, readSettings());
            let context = "";

            if (bootstrapResult) {
                context = `[Constellation] First run — initialized profiles.yaml with "lean" profile. Registered ${bootstrapResult.mcpCount} MCP servers from mcp-config.json. Use profile_create to build your first profile. `;
            } else if (state.baseProfile && state.isDrifted) {
                if (state.exactProfile && state.exactProfile !== state.baseProfile) {
                    context = `[Constellation] Stored profile: \`${state.baseProfile}\` (drifted). Current MCP state matches \`${state.exactProfile}\`. `;
                } else {
                    context = `[Constellation] Base profile: \`${state.baseProfile}\` (modified). `;
                }
            } else if (state.exactProfile) {
                const profile = profiles.profiles[state.exactProfile];
                context = `[Constellation] Active profile: \`${state.exactProfile}\` — ${profile.description}. `;
            } else {
                const extra = state.enabled.length > 0 ? ` MCPs enabled: ${state.enabled.join(", ")}.` : "";
                context = `[Constellation] Custom MCP configuration.${extra} Use profile_switch to set a profile. `;
            }

            context += "Use profile_list, profile_current, profile_switch, profile_create, profile_update, profile_delete, svr_load, svr_unload, svr_register, svr_deregister, or svr_status tools to manage profiles and MCPs.";
            return { additionalContext: context };
        },
    },
    tools: [
        {
            name: "profile_switch",
            description: "Switch to a named profile. Updates MCP server configuration and reports what changed.",
            parameters: {
                type: "object",
                properties: {
                    profile: {
                        type: "string",
                        description: "Profile name to switch to. Use profile_list to see available profiles.",
                    },
                },
                required: ["profile"],
            },
            handler: async (args) => {
                const profiles = loadProfiles();
                if (!profiles) return { textResultForLlm: "Error: profiles.yaml not found at " + PROFILES_PATH, resultType: "failure" };

                const result = applyProfile(args.profile, profiles);
                if (!result.ok) return { textResultForLlm: result.message, resultType: "failure" };

                const mcpErrors = [];
                for (const name of result.disableMcps) {
                    const response = await toggleMcpDisable(name, session.rpc);
                    if (!response.ok) mcpErrors.push(`disable ${name}: ${response.error}`);
                }
                for (const name of result.enableMcps) {
                    const response = await toggleMcpEnable(name, session.rpc);
                    if (!response.ok) mcpErrors.push(`enable ${name}: ${response.error}`);
                }

                const finalSettings = readSettings();
                if (mcpErrors.length === 0) {
                    finalSettings.disabledMcpServers = result.finalDisabled;
                    finalSettings.activeProfile = args.profile;
                } else {
                    const detected = _detectProfileState(profiles, finalSettings);
                    if (detected.exactProfile) {
                        finalSettings.activeProfile = detected.exactProfile;
                    } else if (!(detected.baseProfile && detected.ambiguousMatches.includes(detected.baseProfile))) {
                        finalSettings.activeProfile = null;
                    }
                }
                writeSettings(finalSettings);

                let output = result.message;
                if (mcpErrors.length > 0) {
                    output += `\n⚠️ Some MCP toggles failed: ${mcpErrors.join("; ")}`;
                }
                if (result.workingDir) {
                    output += `\n📂 Recommended working directory: ${result.workingDir}`;
                    output += `\n   Run: cd "${result.workingDir}"`;
                }

                await session.log(`Profile switched to: ${args.profile}`, { ephemeral: true });
                return output;
            },
        },
        {
            name: "profile_list",
            description: "List all available profiles with descriptions and hints.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const profiles = loadProfiles();
                if (!profiles) return { textResultForLlm: "Error: profiles.yaml not found", resultType: "failure" };

                let output = "📋 **Constellation Profiles**\n\n";
                for (const [name, profile] of Object.entries(profiles.profiles)) {
                    output += `**\`${name}\`** — ${profile.description}\n`;
                    output += `  MCPs: ${_formatList(profile.mcp_servers || [])}\n`;
                    if ((profile.plugins || []).length > 0) output += `  Plugins: ${profile.plugins.join(", ")}\n`;
                    output += `  _${profile.hint}_\n\n`;
                }
                return output;
            },
        },
        {
            name: "profile_current",
            description: "Show the currently active profile and MCP state.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const profiles = loadProfiles();
                if (!profiles) return { textResultForLlm: "Error: profiles.yaml not found", resultType: "failure" };

                const state = _detectProfileState(profiles, readSettings());
                let output = "";

                if (state.baseProfile && state.isDrifted) {
                    const profile = profiles.profiles[state.baseProfile];
                    output += `🔧 Base Profile: \`${state.baseProfile}\` (modified)\n`;
                    output += `   ${profile.description}\n`;
                    output += `   MCPs enabled: ${_formatList(state.enabled)}\n`;
                    if (state.extraMcps.length > 0) output += `   À la carte added: ${state.extraMcps.join(", ")}\n`;
                    if (state.missingMcps.length > 0) output += `   À la carte removed: ${state.missingMcps.join(", ")}\n`;
                    if (state.exactProfile && state.exactProfile !== state.baseProfile) {
                        output += `   Exact profile match: ${state.exactProfile}\n`;
                    } else if (state.ambiguousMatches.length > 0) {
                        output += `   Matching profiles: ${state.ambiguousMatches.join(", ")}\n`;
                    }
                    if ((profile.plugins || []).length > 0) output += `   Plugins: ${profile.plugins.join(", ")}\n`;
                    if (profile.working_dir) output += `   Working dir: ${profile.working_dir}\n`;
                    return output.trimEnd();
                }

                if (state.exactProfile) {
                    const profile = profiles.profiles[state.exactProfile];
                    output += `🔧 Active Profile: \`${state.exactProfile}\`\n`;
                    output += `   ${profile.description}\n`;
                    output += `   MCPs: ${_formatList(state.enabled)}\n`;
                    if ((profile.plugins || []).length > 0) output += `   Plugins: ${profile.plugins.join(", ")}\n`;
                    if (profile.working_dir) output += `   Working dir: ${profile.working_dir}\n`;
                    if (state.ambiguousMatches.length > 1) {
                        output += `   Other matching profiles: ${state.ambiguousMatches.filter(name => name !== state.exactProfile).join(", ")}\n`;
                    }
                    return output.trimEnd();
                }

                output += "⚠️ Custom MCP configuration (no profile match).\n";
                output += `   MCPs enabled: ${_formatList(state.enabled)}\n`;
                output += `   MCPs disabled: ${_formatList(state.disabled)}\n`;
                if (state.ambiguousMatches.length > 0) {
                    output += `   Matching profiles: ${state.ambiguousMatches.join(", ")}\n`;
                }
                output += "   Use profile_switch to set a profile.";
                return output;
            },
        },
        {
            name: "profile_create",
            description: "Create a new profile in profiles.yaml.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Profile name (lowercase, hyphens allowed)." },
                    description: { type: "string", description: "Profile description." },
                    mcp_servers: { type: "array", items: { type: "string" }, description: "MCP servers to enable for this profile." },
                    plugins: { type: "array", items: { type: "string" }, description: "Plugins associated with this profile (advisory only)." },
                    working_dir: {
                        anyOf: [{ type: "string" }, { type: "null" }],
                        description: "Recommended working directory, or null.",
                    },
                    hint: { type: "string", description: "Short hint for when to use the profile." },
                },
                required: ["name", "description"],
            },
            handler: async (args) => {
                const profiles = loadProfiles();
                if (!profiles) return { textResultForLlm: "Error: profiles.yaml not found", resultType: "failure" };

                const nameError = _validateName(args.name);
                if (nameError) return { textResultForLlm: `❌ Invalid profile name: ${nameError}`, resultType: "failure" };
                if (profiles.profiles[args.name]) return { textResultForLlm: `❌ Profile already exists: ${args.name}`, resultType: "failure" };

                const descriptionError = _validateYamlString(args.description);
                if (descriptionError) return { textResultForLlm: `❌ Invalid description: ${descriptionError}`, resultType: "failure" };

                const mcps = _validateMcpNames(args.mcp_servers || [], profiles.all_mcp_servers, "mcp_servers");
                if (!mcps.ok) return { textResultForLlm: `❌ ${mcps.error}`, resultType: "failure" };

                const plugins = _validateStringArray(args.plugins || [], "plugins", { useNameValidator: true });
                if (!plugins.ok) return { textResultForLlm: `❌ ${plugins.error}`, resultType: "failure" };

                if (args.working_dir != null) {
                    const workingDirError = _validateYamlString(args.working_dir);
                    if (workingDirError) return { textResultForLlm: `❌ Invalid working_dir: ${workingDirError}`, resultType: "failure" };
                }

                const hint = args.hint ?? "";
                const hintError = _validateYamlString(hint);
                if (hintError) return { textResultForLlm: `❌ Invalid hint: ${hintError}`, resultType: "failure" };

                profiles.profiles[args.name] = {
                    description: args.description,
                    mcp_servers: mcps.values,
                    plugins: plugins.values,
                    working_dir: args.working_dir ?? null,
                    hint,
                };
                saveProfiles(profiles);

                let output = `✅ Created profile: \`${args.name}\`\n`;
                output += `   Description: ${args.description}\n`;
                output += `   MCPs: ${_formatList(mcps.values)}\n`;
                output += `   Plugins: ${_formatList(plugins.values)}\n`;
                output += `   Working dir: ${args.working_dir ?? "null"}\n`;
                output += `   Hint: ${hint || ""}`;
                return output;
            },
        },
        {
            name: "profile_delete",
            description: "Delete a profile from profiles.yaml.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Profile name to delete." },
                },
                required: ["name"],
            },
            handler: async (args) => {
                const profiles = loadProfiles();
                if (!profiles) return { textResultForLlm: "Error: profiles.yaml not found", resultType: "failure" };
                if (!profiles.profiles[args.name]) return { textResultForLlm: `❌ Unknown profile: ${args.name}`, resultType: "failure" };

                const settings = readSettings();
                const state = _detectProfileState(profiles, settings);
                if (settings.activeProfile === args.name || state.baseProfile === args.name || state.exactProfile === args.name) {
                    return { textResultForLlm: `❌ Cannot delete active profile: ${args.name}`, resultType: "failure" };
                }

                delete profiles.profiles[args.name];
                saveProfiles(profiles);
                return `✅ Deleted profile: ${args.name}`;
            },
        },
        {
            name: "profile_update",
            description: "Update an existing profile using delta operations (add/remove MCPs) or field replacement.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Profile name to update." },
                    add_mcps: { type: "array", items: { type: "string" }, description: "MCPs to add to this profile." },
                    remove_mcps: { type: "array", items: { type: "string" }, description: "MCPs to remove from this profile." },
                    description: { type: "string", description: "Replacement description." },
                    hint: { type: "string", description: "Replacement hint." },
                    working_dir: {
                        anyOf: [{ type: "string" }, { type: "null" }],
                        description: "Replacement working directory or null.",
                    },
                    plugins: { type: "array", items: { type: "string" }, description: "Replacement plugin list." },
                },
                required: ["name"],
            },
            handler: async (args) => {
                const profiles = loadProfiles();
                if (!profiles) return { textResultForLlm: "Error: profiles.yaml not found", resultType: "failure" };
                const profile = profiles.profiles[args.name];
                if (!profile) return { textResultForLlm: `❌ Unknown profile: ${args.name}`, resultType: "failure" };

                const addMcps = _validateMcpNames(args.add_mcps || [], profiles.all_mcp_servers, "add_mcps");
                if (!addMcps.ok) return { textResultForLlm: `❌ ${addMcps.error}`, resultType: "failure" };
                const removeMcps = _validateMcpNames(args.remove_mcps || [], profiles.all_mcp_servers, "remove_mcps");
                if (!removeMcps.ok) return { textResultForLlm: `❌ ${removeMcps.error}`, resultType: "failure" };

                const overlap = addMcps.values.filter(name => removeMcps.values.includes(name));
                if (overlap.length > 0) {
                    return { textResultForLlm: `❌ add_mcps and remove_mcps overlap: ${overlap.join(", ")}`, resultType: "failure" };
                }

                if (Object.prototype.hasOwnProperty.call(args, "description")) {
                    const error = _validateYamlString(args.description);
                    if (error) return { textResultForLlm: `❌ Invalid description: ${error}`, resultType: "failure" };
                }
                if (Object.prototype.hasOwnProperty.call(args, "hint")) {
                    const error = _validateYamlString(args.hint);
                    if (error) return { textResultForLlm: `❌ Invalid hint: ${error}`, resultType: "failure" };
                }
                if (Object.prototype.hasOwnProperty.call(args, "working_dir") && args.working_dir != null) {
                    const error = _validateYamlString(args.working_dir);
                    if (error) return { textResultForLlm: `❌ Invalid working_dir: ${error}`, resultType: "failure" };
                }

                let replacementPlugins = null;
                if (Object.prototype.hasOwnProperty.call(args, "plugins")) {
                    const parsedPlugins = _validateStringArray(args.plugins || [], "plugins", { useNameValidator: true });
                    if (!parsedPlugins.ok) return { textResultForLlm: `❌ ${parsedPlugins.error}`, resultType: "failure" };
                    replacementPlugins = parsedPlugins.values;
                }

                const original = JSON.parse(JSON.stringify(profile));
                profile.mcp_servers = _uniqueStrings([
                    ...(profile.mcp_servers || []).filter(name => !removeMcps.values.includes(name)),
                    ...addMcps.values,
                ]);
                if (Object.prototype.hasOwnProperty.call(args, "description")) profile.description = args.description;
                if (Object.prototype.hasOwnProperty.call(args, "hint")) profile.hint = args.hint;
                if (Object.prototype.hasOwnProperty.call(args, "working_dir")) profile.working_dir = args.working_dir;
                if (replacementPlugins) profile.plugins = replacementPlugins;

                saveProfiles(profiles);

                const changes = [];
                if (!_sameStringSet(original.mcp_servers || [], profile.mcp_servers || [])) {
                    changes.push(`MCPs: ${_formatList(original.mcp_servers || [])} → ${_formatList(profile.mcp_servers || [])}`);
                }
                if ((original.description ?? "") !== (profile.description ?? "")) changes.push("Description updated");
                if ((original.hint ?? "") !== (profile.hint ?? "")) changes.push("Hint updated");
                if ((original.working_dir ?? null) !== (profile.working_dir ?? null)) {
                    changes.push(`Working dir: ${original.working_dir ?? "null"} → ${profile.working_dir ?? "null"}`);
                }
                if (!_sameStringSet(original.plugins || [], profile.plugins || [])) {
                    changes.push(`Plugins: ${_formatList(original.plugins || [])} → ${_formatList(profile.plugins || [])}`);
                }

                return `✅ Updated profile: ${args.name}\n   ${changes.length > 0 ? changes.join("\n   ") : "No effective changes."}`;
            },
        },
        // ── Layer 2: À La Carte MCP Loading ──────────────────────────────────
        {
            name: "svr_load",
            description: "Load (unseal) a single MCP server without affecting others. Additive operation. Retries once on failure.",
            parameters: {
                type: "object",
                properties: {
                    server: {
                        type: "string",
                        description: "MCP server name to load (e.g. teams, kusto, azure-devops)",
                    },
                },
                required: ["server"],
            },
            handler: async (args) => {
                const profiles = loadProfiles();
                const allMcps = profiles ? profiles.all_mcp_servers : [];
                if (!allMcps.includes(args.server)) {
                    return { textResultForLlm: `❌ Unknown MCP server: "${args.server}". Available: ${allMcps.join(", ")}`, resultType: "failure" };
                }
                const settings = readSettings();
                const disabled = settings.disabledMcpServers || [];
                if (!disabled.includes(args.server)) {
                    return `✅ ${args.server} is already loaded.`;
                }

                let result = await toggleMcpEnable(args.server, session.rpc);
                if (!result.ok) {
                    await session.log(`⚠️ MCP load failed, retrying: ${args.server}`, { ephemeral: true });
                    result = await toggleMcpEnable(args.server, session.rpc);
                }
                if (result.ok) {
                    _reconcileActiveProfile(profiles);
                    await session.log(`⚡ MCP loaded: ${args.server}`, { ephemeral: true });
                    return `✅ Loaded: ${args.server}`;
                }
                return { textResultForLlm: `❌ Failed to load ${args.server} after retry: ${result.error}`, resultType: "failure" };
            },
        },
        {
            name: "svr_unload",
            description: "Unload (seal) a single MCP server without affecting others.",
            parameters: {
                type: "object",
                properties: {
                    server: {
                        type: "string",
                        description: "MCP server name to unload (e.g. teams, kusto, azure-devops)",
                    },
                },
                required: ["server"],
            },
            handler: async (args) => {
                const profiles = loadProfiles();
                const allMcps = profiles ? profiles.all_mcp_servers : [];
                if (!allMcps.includes(args.server)) {
                    return { textResultForLlm: `❌ Unknown MCP server: "${args.server}". Available: ${allMcps.join(", ")}`, resultType: "failure" };
                }
                const settings = readSettings();
                const disabled = settings.disabledMcpServers || [];
                if (disabled.includes(args.server)) {
                    return `✅ ${args.server} is already unloaded.`;
                }

                const result = await toggleMcpDisable(args.server, session.rpc);
                if (result.ok) {
                    _reconcileActiveProfile(profiles);
                    await session.log(`⚡ MCP unloaded: ${args.server}`, { ephemeral: true });
                    return `✅ Unloaded: ${args.server}`;
                }
                return { textResultForLlm: `❌ Failed to unload ${args.server}: ${result.error}`, resultType: "failure" };
            },
        },
        {
            name: "svr_register",
            description: "Register a new MCP server in profiles.yaml and mcp-manifest.yaml.",
            parameters: {
                type: "object",
                properties: {
                    server: { type: "string", description: "Server name (lowercase, hyphens allowed)." },
                    description: { type: "string", description: "Server description." },
                    capabilities: { type: "array", items: { type: "string" }, description: "Capability list." },
                    use_when: { type: "string", description: "When to use this server." },
                },
                required: ["server", "description", "capabilities", "use_when"],
            },
            handler: async (args) => {
                const profiles = loadProfiles();
                if (!profiles) return { textResultForLlm: "Error: profiles.yaml not found", resultType: "failure" };
                const manifest = loadMcpManifest();

                const nameError = _validateName(args.server);
                if (nameError) return { textResultForLlm: `❌ Invalid server name: ${nameError}`, resultType: "failure" };
                if (profiles.all_mcp_servers.includes(args.server)) {
                    return { textResultForLlm: `❌ Server already registered: ${args.server}`, resultType: "failure" };
                }

                const descriptionError = _validateYamlString(args.description);
                if (descriptionError) return { textResultForLlm: `❌ Invalid description: ${descriptionError}`, resultType: "failure" };
                const capabilities = _validateStringArray(args.capabilities, "capabilities", { allowEmpty: false });
                if (!capabilities.ok) return { textResultForLlm: `❌ ${capabilities.error}`, resultType: "failure" };
                const useWhenError = _validateYamlString(args.use_when);
                if (useWhenError) return { textResultForLlm: `❌ Invalid use_when: ${useWhenError}`, resultType: "failure" };

                profiles.all_mcp_servers = [...profiles.all_mcp_servers, args.server];
                manifest.servers[args.server] = {
                    description: args.description,
                    capabilities: capabilities.values,
                    use_when: args.use_when,
                };

                saveProfiles(profiles);
                saveMcpManifest(manifest);

                const warning = !_readMcpJsonServers().includes(args.server)
                    ? `\n⚠️ Warning: ${args.server} is not present in mcp-config.json — it may not be loadable until configured there.`
                    : "";

                return `✅ Registered server: ${args.server}\n   Description: ${args.description}\n   Capabilities: ${capabilities.values.join(", ")}\n   Use when: ${args.use_when}${warning}`;
            },
        },
        {
            name: "svr_deregister",
            description: "Deregister an MCP server from profiles.yaml and mcp-manifest.yaml. Removes from all profiles.",
            parameters: {
                type: "object",
                properties: {
                    server: { type: "string", description: "Server name to remove." },
                },
                required: ["server"],
            },
            handler: async (args) => {
                const profiles = loadProfiles();
                if (!profiles) return { textResultForLlm: "Error: profiles.yaml not found", resultType: "failure" };
                if (!profiles.all_mcp_servers.includes(args.server)) {
                    return { textResultForLlm: `❌ Unknown MCP server: ${args.server}`, resultType: "failure" };
                }

                const manifest = loadMcpManifest();
                const affectedProfiles = [];
                for (const [name, profile] of Object.entries(profiles.profiles)) {
                    if ((profile.mcp_servers || []).includes(args.server)) {
                        profile.mcp_servers = (profile.mcp_servers || []).filter(server => server !== args.server);
                        affectedProfiles.push(name);
                    }
                }

                let unloadMessage = "";
                const settings = readSettings();
                const disabled = settings.disabledMcpServers || [];
                if (!disabled.includes(args.server)) {
                    const unloadResult = await toggleMcpDisable(args.server, session.rpc);
                    if (!unloadResult.ok) {
                        unloadMessage = `⚠️ Failed to unload active server: ${unloadResult.error}`;
                    } else {
                        unloadMessage = `Unloaded active server: ${args.server}`;
                    }
                }

                profiles.all_mcp_servers = profiles.all_mcp_servers.filter(server => server !== args.server);
                delete manifest.servers[args.server];
                saveProfiles(profiles);
                saveMcpManifest(manifest);

                // Only remove from disabledMcpServers if not in mcp-config.json
                const mcpJsonServers = _readMcpJsonServers();
                if (!mcpJsonServers.includes(args.server)) {
                    const finalSettings = readSettings();
                    finalSettings.disabledMcpServers = (finalSettings.disabledMcpServers || []).filter(server => server !== args.server);
                    writeSettings(finalSettings);
                }
                _reconcileActiveProfile(profiles);

                let output = `✅ Deregistered server: ${args.server}\n`;
                output += `   Removed from profiles: ${affectedProfiles.length > 0 ? affectedProfiles.join(", ") : "none"}`;
                if (unloadMessage) output += `\n   ${unloadMessage}`;
                return output;
            },
        },
        {
            name: "svr_status",
            description: "Show the current state of all MCP servers — which are loaded, unloaded, and the total registry.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const profiles = loadProfiles();
                const registeredMcps = profiles ? profiles.all_mcp_servers : [];
                const settings = readSettings();
                const disabled = settings.disabledMcpServers || [];
                const mcpJsonServers = _readMcpJsonServers();

                const allKnown = Array.from(new Set([...registeredMcps, ...mcpJsonServers]));
                const loaded = allKnown.filter(server => !disabled.includes(server));
                const unloaded = allKnown.filter(server => disabled.includes(server));
                const inRegistryOnly = registeredMcps.filter(server => !mcpJsonServers.includes(server));
                const inMcpJsonOnly = mcpJsonServers.filter(server => !registeredMcps.includes(server));

                let output = `📡 **MCP Server Status** (${allKnown.length} known)\n\n`;
                output += `**Loaded** (${loaded.length}): ${_formatList(loaded)}\n`;
                output += `**Unloaded** (${unloaded.length}): ${_formatList(unloaded)}\n`;
                output += `**Registry**: ${registeredMcps.length} servers\n`;

                if (inMcpJsonOnly.length > 0) {
                    output += `\n⚠️ In mcp-config.json but not registered: ${inMcpJsonOnly.join(", ")}`;
                }
                if (inRegistryOnly.length > 0) {
                    output += `\n⚠️ Registered but not in mcp-config.json: ${inRegistryOnly.join(", ")}`;
                }
                return output;
            },
        },
    ],
});

await session.log("Constellation extension loaded");
