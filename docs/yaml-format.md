# YAML Format Reference

Constellation uses a lightweight YAML parser tailored to the structure of `profiles.yaml` and `mcp-manifest.yaml`. This document describes the exact format constraints.

## profiles.yaml

### Structure

```yaml
# Comments are ignored during parsing
all_mcp_servers:
  - server-name-1
  - server-name-2

always_on:
  skills:
    - "skill-name"
  instructions:
    - "~/.github/copilot-instructions.md"

profiles:
  my-profile:
    description: "What this profile is for"
    mcp_servers:
      - "server-name-1"
    plugins: []
    working_dir: null
    hint: "When to use this profile"
```

### Rules

| Field | Format | Example |
|---|---|---|
| `all_mcp_servers` list items | Bare strings (no quotes) | `  - kusto` |
| `description` | Double-quoted string | `description: "My profile"` |
| `hint` | Double-quoted string | `hint: "Use for data tasks"` |
| `working_dir` | Double-quoted path or `null` | `working_dir: "C:\\Users\\me"` |
| `mcp_servers` | List or `[]` | See below |
| `plugins` | List or `[]` | See below |

### Lists

Non-empty lists use block syntax with quoted items:

```yaml
mcp_servers:
  - "kusto"
  - "azure-devops"
```

Empty lists use inline syntax:

```yaml
plugins: []
```

### Paths (Windows)

Backslashes in paths must be escaped as `\\` inside double quotes (JSON-style escaping):

```yaml
working_dir: "C:\\Users\\gacurtin\\my-project"
```

The parser uses `JSON.parse()` to unescape quoted strings, so the in-memory value will be `C:\Users\gacurtin\my-project`.

### Profile names

- Must start with a lowercase letter
- May contain lowercase letters, digits, and hyphens
- 2–40 characters long
- Indented with exactly 2 spaces under `profiles:`

```yaml
profiles:
  my-profile:     # ✅ valid
  My-Profile:     # ❌ uppercase
  a:              # ❌ too short
  123-profile:    # ❌ starts with digit
```

## mcp-manifest.yaml

### Structure

```yaml
servers:
  my-server:
    description: "What this server does"
    capabilities:
      - "Capability 1"
      - "Capability 2"
    use_when: "When the user asks about X"
    note: "Optional note"  # optional field
```

### Rules

| Field | Format | Required |
|---|---|---|
| `description` | Double-quoted string | Yes |
| `capabilities` | List of strings or `[]` | Yes |
| `use_when` | Double-quoted string | Yes |
| `note` | Double-quoted string | No |

### Server names

Same constraints as profile names:
- Lowercase letters, digits, hyphens
- Starts with a letter
- 2–40 characters

## What the parser ignores

- Comment lines (starting with `#`)
- Blank lines
- Inline comments (text after `#` on a data line)
- YAML features not listed above (anchors, aliases, flow mappings, multi-line strings, single quotes)

## Round-trip safety

The serializer regenerates the file from the parsed data structure. This means:
- **Comments are replaced** with standard header comments
- **Ordering is preserved** for profiles and servers
- **Formatting is normalized** (consistent indentation, quoting)
- **Data is preserved exactly** — string values, lists, and null/empty values round-trip correctly

If you need to preserve custom comments, make your edits through the tools (`profile_update`, `svr_register`) rather than hand-editing the file.
