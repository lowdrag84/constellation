# Constellation

**MCP profile management for GitHub Copilot CLI.** Controls which MCP servers are active per task domain, reducing token usage by ~50% per turn.

## Why?

Each MCP server registers 5–35 tools into the system prompt. Those tool schemas (name + description + JSON parameters) cost ~150–300 tokens each and are re-sent on **every turn**. With 10+ MCP servers loaded, the system prompt alone can consume 30,000+ tokens per turn.

Constellation lets you define **profiles** — named configurations that enable only the MCP servers you need for the current task. Switching from a full loadout to a minimal profile removes tens of thousands of tokens per turn, roughly **halving your per-turn input cost**.

A secondary benefit: smaller system prompts delay context compaction, reducing summarization overhead across longer sessions.

## What For?

If you use multiple MCP servers with Copilot CLI, you're paying a hidden tax on every single turn. Here's what we measured:

### 🔢 The numbers are staggering

A real-world profile switch removed **~109 tools** across 6 MCP servers. Each tool definition is ~150–300 tokens of schema. That's **~16,000–33,000 tokens removed from the system prompt** — and the system prompt is re-sent on **every turn**.

Over a 30-turn session, that's **480,000–990,000 tokens saved** on input alone.

### 💰 Your per-turn cost drops by half (or more)

Tool schemas are typically the **heaviest component** of the system prompt — often 50%+ of your per-turn input. Removing unused tools via a profile switch roughly halves your per-turn cost. With a full-to-minimal switch, the reduction can be **2x or better**.

This makes profile switching the single most impactful token optimization available in Copilot CLI today.

### 🧠 Longer sessions stay sharper

A smaller system prompt means more context window is available for your actual conversation. This means:

- **Compaction triggers less frequently** — the system doesn't need to summarize your conversation history as often
- **Fewer summarization calls** = fewer tokens spent on overhead
- **This compounds** — the longer your session runs, the more you save

### 🎯 Better responses, not just cheaper ones

When the LLM sees 100+ tool definitions, it has to evaluate all of them on every turn. Reducing to just the 5–10 tools you actually need means:

- **Faster tool selection** — less noise, more signal
- **Fewer hallucinated tool calls** — the model won't try to use tools from an unrelated domain
- **More context for your work** — tokens not spent on tool schemas are available for code, conversation, and reasoning

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
git clone https://github.com/lowdrag84/constellation.git
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

> "Clone `lowdrag84/constellation` and run the setup script"

Or for fully hands-off setup:

> "Install the Constellation extension from `lowdrag84/constellation`. Scan my MCP config and register all servers."

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

> **Note:** The [GitHub Copilot SDK](https://github.com/github/copilot-sdk) is currently in **Public Preview** (`1.0.0-beta.4`). The `session.rpc.mcp.enable/disable` API is a low-level RPC method that exists in the public SDK but does not yet have dedicated documentation — it may change between beta versions.

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
