# Agent Skills Specification (from agentskills.io)

## Directory Structure
```
skill-name/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
├── assets/           # Optional: templates, resources
└── ...               # Any additional files or directories
```

## SKILL.md Format
The `SKILL.md` file must contain YAML frontmatter followed by Markdown content.

### Frontmatter Fields
| Field | Required | Constraints |
|-------|----------|-------------|
| `name` | Yes | Max 64 characters. Lowercase letters, numbers, and hyphens only. Must not start or end with a hyphen. |
| `description` | Yes | Max 1024 characters. Non-empty. Describes what the skill does and when to use it. |
| `license` | No | License name or reference to a bundled license file. |
| `compatibility` | No | Max 500 characters. Indicates environment requirements. |
| `metadata` | No | Arbitrary key-value mapping for additional metadata. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools the skill may use. (Experimental) |

### name Field Rules
- Must be 1-64 characters
- May only contain unicode lowercase alphanumeric characters (a-z, 0-9) and hyphens (-)
- Must not start or end with a hyphen (-)
- Must not contain consecutive hyphens (--)
- Must match the parent directory name

### description Field Rules
- Must be 1-1024 characters
- Should describe both what the skill does and when to use it
- Should include specific keywords that help agents identify relevant tasks

### Minimal Example
```yaml
---
name: skill-name
description: A description of what this skill does and when to use it.
---
```

### Example with Optional Fields
```yaml
---
name: pdf-processing
description: Extract PDF text, fill forms, merge files. Use when handling PDFs.
license: Apache-2.0
metadata:
  author: example-org
  version: "1.0"
---
```

## Body Content
- Markdown body after the frontmatter contains the skill instructions
- No format restrictions
- Recommended: Step-by-step instructions, Examples, Edge cases
- Keep SKILL.md under 500 lines
- Keep under 5000 tokens recommended

## Progressive Disclosure
1. Metadata (~100 tokens): name + description loaded at startup
2. Instructions (< 5000 tokens): full SKILL.md loaded on activation
3. Resources (as needed): scripts/, references/, assets/ loaded on demand
