# SkillForge

**A zero-install, single-file AI agent skill manager.**

SkillForge is a self-contained HTML application that gives you a visual, intuitive interface for creating, editing, organizing, and deploying AI agent skills. It reads and writes directly to your local skills folder using the browser's File System Access API — no backend, no account, no npm, and no command line.

## Features

- **Visual Skill Library** — Browse all your skills as cards with search, filter, and sort
- **Guided Wizard** — 5-step creation flow with templates, no YAML knowledge required
- **Pro Editor** — Split-pane editor with raw source on the left and live preview on the right
- **Validation Engine** — Real-time compliance checking against the agentskills.io specification
- **Quality Scorer** — 5-dimension quality rating (0–100) for every skill
- **Multi-Agent Support** — Works with Claude Code, OpenAI Codex, Cursor, GitHub Copilot, and more
- **Export/Import** — ZIP export (single or all), import from URL
- **Bulk Operations** — Multi-select skills for batch delete, export, or tag
- **Version History** — Local snapshots saved on every edit, with one-click restore
- **Collections** — Group skills into named collections for organization and export
- **Cross-Agent Sync** — Open multiple folders to compare and copy skills between agents
- **AI-Assisted Writing** — Bring your own API key (OpenAI or Anthropic) for AI suggestions
- **Dark Mode** — Follows system preference with manual override (system/light/dark)
- **10 Built-in Templates** — Code Reviewer, Documentation Writer, PR Description Writer, Research Synthesizer, Meeting Notes Formatter, Email Drafter, Data Analyst, Brand Voice Writer, Weekly Standup Generator, and Blank
- **Fully Offline** — No network requests, no telemetry, no analytics
- **Accessible** — WCAG 2.1 AA: keyboard navigation, ARIA labels, 4.5:1 contrast ratios

## Usage

1. **Download** `SkillForge.html`
2. **Double-click** to open it in your browser
3. Click **Open Skills Folder** and select your agent's skills directory
4. Start browsing, creating, and editing skills

That's it. No install, no build, no dependencies.

## Browser Compatibility

| Browser | Supported |
|---------|-----------|
| Chrome 120+ | Full support |
| Edge 120+ | Full support |
| Brave | Full support |
| Arc | Full support |
| Opera | Full support |
| Firefox | Partial (directory picker requires flag) |
| Safari | Not supported (no File System Access API) |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` / `Cmd+K` | Focus search |
| `Ctrl+N` / `Cmd+N` | Create new skill |
| `Ctrl+S` / `Cmd+S` | Save (in editor) |
| `Tab` | Insert indent (in editor) |
| `Escape` | Close panel/modal |

## Skill Format Reference

SkillForge reads and writes the [agentskills.io](https://agentskills.io/specification) open standard:

```
skill-name/
├── SKILL.md          # Required: YAML frontmatter + Markdown instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
└── assets/           # Optional: templates, resources
```

### SKILL.md Format

```yaml
---
name: my-skill               # Required. 1-64 chars, lowercase, hyphens
description: What it does.    # Required. 1-1024 chars
license: Apache-2.0           # Optional
compatibility: node >= 18     # Optional, max 500 chars
metadata:                      # Optional key-value pairs
  author: your-name
  version: "1.0"
allowed-tools: Bash Read Write # Optional, space-delimited
---

# My Skill

Your Markdown instructions here.
```

### Validation Rules

- `name`: max 64 characters, `[a-z0-9-]`, no leading/trailing/consecutive hyphens
- `description`: max 1024 characters, non-empty
- Body: recommended under 500 lines / 5,000 tokens
- YAML frontmatter must be valid

## Common Skill Folder Paths

| Agent | Default Path |
|-------|-------------|
| Claude Code | `~/.claude/skills` |
| OpenAI Codex | `~/.codex/skills` |
| Cursor | `~/.cursor/skills` |
| GitHub Copilot | `~/.github/skills` |

## Technical Details

- **Size**: ~116 KB (all CSS, JS, YAML parser, Markdown renderer, and ZIP builder inlined)
- **Dependencies**: Zero runtime dependencies. Everything is embedded.
- **Storage**: Skills on your local filesystem; preferences in localStorage
- **Privacy**: No data is ever transmitted to any server

## License

Apache License 2.0 — see [LICENSE](https://www.apache.org/licenses/LICENSE-2.0)

Copyright 2026 SkillForge Contributors
