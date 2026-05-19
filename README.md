# Constellation

**MCP profile management for GitHub Copilot CLI.** Controls which MCP servers are active per task domain, reducing token usage by ~50% per turn.

## Why?

Each MCP server registers 5–35 tools into the system prompt. Those tool schemas (name + description + JSON parameters) cost ~150–300 tokens each and are re-sent on **every turn**. With 10+ MCP servers loaded, the system prompt alone can consume 30,000+ tokens per turn.

Constellation lets you define **profiles** — named configurations that enable only the MCP servers you need for the current task. Switching from a full loadout to a minimal profile removes tens of thousands of tokens per turn, roughly **halving your per-turn input cost**.

A secondary benefit: smaller system prompts delay context compaction, reducing summarization overhead across longer sessions.

## Features

| Tool | What it does |
|---|---|
| `profile_switch` | Switch to a named profile — enables its MCPs, disables everything else |
| `profile_list` | List all profiles with descriptions |
| `profile_current` | Show active profile, detect drift from à la carte changes |
| `profile_create` | Create a new profile |
| `profile_update` | Delta update — add/remove MCPs, change description/hint/working_dir |
| `profile_delete` | Delete a profile |
| `svr_load` | Load a single MCP server (à la carte, additive) |
| `svr_unload` | Unload a single MCP server (à la carte, subtractive) |
| `svr_register` | Register a new MCP in the profile registry + capability manifest |
| `svr_deregister` | Remove an MCP from all files and profiles |
| `svr_status` | Show which MCPs are loaded, unloaded, and registered |

### Smart profile detection

When you load MCPs à la carte (e.g., `svr_load kusto` then `svr_load azure-devops`), Constellation automatically detects if your current MCP state matches a named profile and updates accordingly. No manual `profile_switch` needed.

## Requirements

- **GitHub Copilot CLI** ≥ 1.0.48
- **Windows** (Mac/Linux support planned)
- No additional dependencies — the extension SDK (`@github/copilot-sdk/extension`) is bundled with the CLI runtime

## Installation

### Option A: Setup script (recommended)

```powershell
git clone https://github.com/gacurtin_microsoft/constellation.git
cd constellation
.\setup.ps1
```

The script will:
1. Check your CLI version
2. Copy `extension.mjs` to `~/.copilot/extensions/constellation/`
3. Scan your `mcp-config.json` for existing MCP servers
4. Ask if you want to register them all (creates `profiles.yaml` + `mcp-manifest.yaml`)

Use `.\setup.ps1 -SkipScan` to skip the MCP scan and start with just a minimal `lean` profile.

Use `.\setup.ps1 -Force` to overwrite an existing extension installation.

### Option B: Manual installation

```powershell
# 1. Copy the extension
mkdir ~\.copilot\extensions\constellation -Force
copy extension.mjs ~\.copilot\extensions\constellation\extension.mjs

# 2. Copy example configs (if you don't have them yet)
copy profiles.yaml.example ~\.copilot\profiles.yaml
copy mcp-manifest.yaml.example ~\.copilot\mcp-manifest.yaml
```

### Option C: LLM-assisted installation

In a Copilot CLI session, ask:

> "Clone gacurtin_microsoft/constellation and run the setup script"

Or for fully hands-off setup:

> "Install the Constellation extension from gacurtin_microsoft/constellation. Scan my MCP config and register all servers."

The LLM can run `setup.ps1` or perform the manual steps directly.

### First-run auto-bootstrap

If you install only `extension.mjs` without creating `profiles.yaml`, Constellation will auto-bootstrap on the next session start:
- Creates `profiles.yaml` with a default `lean` profile
- Scans `mcp-config.json` and registers all found servers
- Creates `mcp-manifest.yaml` with placeholder entries

## Usage

### Create your first profile

```
> profile_create { name: "data", description: "Data engineering", mcp_servers: ["kusto", "azure-devops"] }
✅ Created profile: `data`
```

### Switch profiles

```
> profile_switch { profile: "data" }
🔄 Profile shift → `data`
   MCPs enabled: kusto, azure-devops
   MCPs disabled: teams, m365-user, ...
```

### À la carte loading

```
> svr_load { server: "teams" }
✅ Loaded: teams

> profile_current
🔧 Base Profile: `data` (modified)
   À la carte added: teams
```

### Register a new MCP

```
> svr_register { server: "my-tool", description: "My custom tool", capabilities: ["Do things"], use_when: "User asks about my tool" }
✅ Registered server: my-tool
```

## File Structure

| File | Location | Purpose |
|---|---|---|
| `extension.mjs` | `~/.copilot/extensions/constellation/` | The extension code (11 tools + bootstrap hook) |
| `profiles.yaml` | `~/.copilot/` | Profile definitions + MCP server registry |
| `mcp-manifest.yaml` | `~/.copilot/` | MCP capability catalog for autonomous loading |
| `settings.json` | `~/.copilot/` | Runtime state (read/written by extension, not user-edited) |
| `mcp-config.json` | `~/.copilot/` | CLI MCP server configurations (read-only by extension) |

## YAML Format Constraints

The extension uses a hand-rolled YAML parser optimized for the specific structure of `profiles.yaml` and `mcp-manifest.yaml`. If you edit these files manually, follow these rules:

- All string values **must** be double-quoted: `description: "my value"`
- Backslashes in paths are JSON-escaped: `working_dir: "C:\\Users\\me\\project"`
- Empty arrays use inline syntax: `mcp_servers: []`
- Null values use bare keyword: `working_dir: null`
- Profile names are 2-space indented under `profiles:`
- List items use `  - ` syntax under their parent key
- Comments (`#`) and blank lines are preserved on read but regenerated on write

See [docs/yaml-format.md](docs/yaml-format.md) for complete format documentation.

## How It Works

Constellation is a [Copilot CLI extension](https://docs.github.com/en/copilot/github-copilot-in-the-cli) — a Node.js ES module that communicates with the CLI via JSON-RPC over stdio.

The key SDK capability is `session.rpc.mcp.enable/disable`, which toggles MCP servers **at runtime** without restarting the session. Profile switching simply computes which servers to enable/disable and calls these methods.

The extension has zero external dependencies. The `@github/copilot-sdk/extension` import is automatically resolved by the CLI runtime — no `npm install` needed.

## Multi-Machine Sync

`profiles.yaml` and `mcp-manifest.yaml` define your profile configurations and are safe to sync across machines (e.g., via a dotfiles repo). `settings.json` contains runtime state (`disabledMcpServers`, `activeProfile`) and should **not** be synced — it's machine-specific.

## Platform Support

| Platform | Status |
|---|---|
| Windows (PowerShell) | ✅ Supported |
| macOS | 🔜 Planned |
| Linux | 🔜 Planned |

The extension itself (`extension.mjs`) is cross-platform. Only the setup script (`setup.ps1`) is Windows-specific. Mac/Linux users can follow the manual installation steps.

## Contributing

Contributions welcome! Please open an issue first to discuss proposed changes.

## Acknowledgments

Built with [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) and the Copilot Extension SDK.
