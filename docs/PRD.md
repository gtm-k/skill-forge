# SkillForge: AI Agent Skill Manager
## Product Requirements Document (PRD) · v1.0
**License:** Apache 2.0 | **Format:** Single-File HTML App | **Standard:** agentskills.io open standard

***

## Executive Summary

SkillForge is a zero-install, single-file HTML application that gives anyone — from first-time AI users to seasoned developers — a visual, intuitive interface for creating, editing, organizing, and deploying AI agent skills. It reads and writes directly to a user's local skills folder using the browser's File System Access API, requiring no backend, no account, no npm, and no command line. The app is licensed under Apache 2.0, making it freely forkable and embeddable in any workflow.

The agent skills ecosystem is exploding: Anthropic published the Agent Skills open standard in December 2025, and adoption by Microsoft, OpenAI, GitHub, Cursor, Figma, and Atlassian followed immediately. Yet management tooling for non-developers remains almost entirely CLI-dependent — a gap validated by SkillHub's rapid growth to 1,000 users in two weeks. SkillForge fills that gap with a self-contained, browser-native tool anyone can download and double-click.[^1][^2]

***

## 1. Problem Statement

### 1.1 The Ecosystem Context

AI agent skills are modular capability files — each skill is a directory containing a `SKILL.md` file with YAML frontmatter and markdown instructions. The open standard at agentskills.io defines a universal format compatible with Claude Code, OpenAI Codex, Cursor, GitHub Copilot, VS Code, and 20+ other agents. Skills follow a **progressive disclosure** pattern: the agent pre-loads only lightweight metadata (~100 tokens per skill) at startup, then loads full instructions only when a skill is triggered. This architecture makes skills powerful — but the file management behind it is entirely manual.[^3][^4][^5][^6][^7]

### 1.2 Documented User Pain Points

Community research surfaces consistent frustrations across all user levels:[^8][^9][^1]

| Pain Point | Who It Affects | Current Workaround |
|---|---|---|
| Skills scattered across directories, no overview | All users | Manual file browsing |
| 75,000+ skills exist but can't be found | Beginners / intermediate | GitHub search, hours wasted[^1] |
| No way to validate if a skill is well-formed | Beginners | Trial and error |
| Skills locked to one agent (Claude ≠ Perplexity)[^10] | Power users | Copy-paste and manual edits |
| CLI tools inaccessible to non-developers | Beginners | Give up, don't use skills |
| Blank canvas anxiety when creating a new skill | All users | Re-writing from scratch[^11] |
| No search, no tagging, no versioning | Pro users | None available |
| Can't easily share skills with a team | Teams | Email/Slack file sharing |

As one developer summarized: *"The problem isn't installation. It's discovery — and cross-agent management."*[^1]

### 1.3 Why Existing Tools Fall Short

| Tool | Approach | Barrier |
|---|---|---|
| OpenSkills CLI[^12] | `npx` terminal command | Requires Node.js, CLI knowledge |
| akm CLI[^9] | Indexed stash via terminal | CLI-only, no visual UI |
| Skillfile[^13] | Declarative config file | Still requires text editing and config syntax |
| SkillHub.club[^1] | Desktop app + cloud | Requires install, account, and internet |
| PromptSmith[^14] | Docker self-hosted | Requires Docker, server setup |
| openskill.online[^15] | Web app | Requires account, no local file access |

No existing tool is a zero-setup, fully visual, offline-capable, local-first manager.

***

## 2. Product Vision

**SkillForge is the Finder/Explorer for AI agent skills.** Just as macOS Finder lets any user browse, rename, move, and preview files without touching a terminal, SkillForge gives every user a clean visual canvas to manage their entire skill library — from their browser, offline, with no account required.

> *"Point at your skills folder. See everything. Change anything."*

***

## 3. Target Users

### 3.1 User Personas

**Persona 1 — The Newcomer (Non-Developer)**
- Never opened a terminal; uses Claude.ai or Perplexity Computer daily
- Knows skills exist but doesn't know how to create or manage them
- Goal: get productivity wins without needing to learn Markdown or YAML
- Needs: guided creation wizard, templates, validation, friendly language

**Persona 2 — The Practitioner (Power User / Prompt Engineer)**
- Manages 20–100+ skills across Claude Code, Cursor, and Codex
- Pain: no overview, can't search, can't bulk-edit, can't share
- Goal: library-level organization with tags, search, export
- Needs: fast editing, multi-agent compatibility view, bulk operations

**Persona 3 — The Builder (Developer / Team Lead)**
- Builds skills as reusable workflows for a team or open-source project
- Pain: no validation tooling, no quality scoring, no version history
- Goal: create production-quality skills quickly with confidence
- Needs: YAML validator, live preview, spec compliance checker, export to ZIP

***

## 4. Solution: Single-File HTML Application

### 4.1 Why a Single HTML File?

After evaluating all distribution approaches, a single `.html` file is the optimal choice for SkillForge's accessibility goals:

| Approach | Setup Required | Works Offline | Accesses Local Files | Platform |
|---|---|---|---|---|
| **Single HTML File (SkillForge)** | **None — double-click** | **Yes** | **Yes (File System API)** | **Any browser** |
| Electron Desktop App | Install executable | Yes | Yes | Platform-specific |
| VS Code Extension | VS Code + install | Yes | Yes | VS Code only |
| CLI Tool | Node.js + npm install | Yes | Yes | Terminal knowledge |
| Cloud Web App | Account + internet | No | No (uploads only) |  Browser |
| Python Script | Python + dependencies | Yes | Yes | Terminal knowledge |

Single-file HTML apps have proven remarkably durable — TiddlyWiki has operated on this model for over 20 years. The pattern requires only a browser and provides complete portability: the file can be shared via email, Dropbox, or GitHub with zero loss of functionality.[^16][^17][^18]

The **File System Access API** (`window.showDirectoryPicker()`) is the key enabling technology: it allows the browser to request permission to read and write a directory the user selects, without any backend or file upload. All file operations stay local and private.[^19][^20][^21]

### 4.2 Technical Foundation

```
SkillForge.html
├── <style>   — All CSS (Tailwind CDN or inline styles, embedded fonts)
├── <script>  — All JavaScript (vanilla JS, no frameworks required)
└── <body>    — Single-page app shell with dynamic rendering
```

- **Data layer:** File System Access API for read/write to user's skills folder
- **State layer:** In-memory JavaScript objects + localStorage for preferences
- **Rendering:** Vanilla JS DOM manipulation (no React/Vue dependency)
- **Parsing:** Lightweight YAML frontmatter parser (embedded, <5KB)
- **Markdown:** Marked.js (embedded for live preview)
- **No CDN dependencies at runtime** — all libraries must be inlined at build time

> **Browser Compatibility Note:** The File System Access API is fully supported in Chromium-based browsers (Chrome, Edge, Arc, Brave, Opera). Firefox support is partial (file picker works, directory picker requires a flag). Safari does not support `showDirectoryPicker`. The app must display a clear compatibility notice on load.

***

## 5. Feature Requirements

### 5.1 Core Features (v1.0 — MVP)

#### F-01: Folder Onboarding
- On first open, display a full-screen welcome screen with a single "Open Skills Folder" button
- Use `window.showDirectoryPicker()` to request access to the user's local skills directory
- Store folder handle in localStorage (re-request permission on subsequent opens)
- Display the resolved folder path prominently in the UI
- **Zero required knowledge:** Include a tooltip explaining common skill folder paths per agent (e.g., `~/.claude/skills`, `~/.codex/skills`)

#### F-02: Skill Library Dashboard
- Display all discovered skills as **visual cards** in a responsive grid
- Each card shows: skill name, description (truncated), tag badges, agent compatibility icons, last-modified date, and line count
- Filter bar: search by name/description (real-time), filter by tags, filter by agent compatibility
- Sort options: alphabetical, last modified, line count, newly created
- Empty state: friendly illustration + "Create Your First Skill" CTA

#### F-03: Skill Creator — Guided Wizard (Beginner Mode)
A step-by-step creation flow, no Markdown/YAML knowledge required:

1. **Step 1 — Name & Purpose:** Enter skill name (live slug preview) + plain-English description
2. **Step 2 — Choose a Template:** Select from starter templates (see Section 5.3) with preview
3. **Step 3 — Customize Instructions:** Rich text area with guided prompts ("What should the agent do first?", "What's the output format?")
4. **Step 4 — Advanced Options (collapsible):** Dependencies, compatibility flags, allowed tools
5. **Step 5 — Review & Save:** Live YAML frontmatter preview + skill structure preview before write

#### F-04: Skill Editor — Pro Mode
- Split-pane editor: raw Markdown/YAML on left, live rendered preview on right
- Syntax highlighting for YAML frontmatter (distinct color zone)
- In-editor validation: inline warnings for spec violations (name too long, description missing, etc.)
- Quick-access toolbar: Insert frontmatter template, Insert code block, Insert reference link
- Auto-save on blur with visual indicator ("Saved ✓" / "Unsaved changes")
- Toggle between Wizard mode and Pro mode at any time

#### F-05: Skill Validation Engine
- Real-time compliance checking against the agentskills.io specification:[^5]
  - `name` ≤ 64 characters, lowercase letters/numbers/hyphens only, no leading/trailing hyphens
  - `description` ≤ 1024 characters, non-empty
  - SKILL.md ≤ 500 lines / ≤ 5000 tokens (with line count display)[^22]
  - YAML frontmatter is valid and parseable
- Visual quality score (🔴 Issues / 🟡 Warnings / 🟢 Valid) on each skill card and in the editor
- One-click "Fix Issues" for auto-correctable problems (e.g., lowercase slug generation)

#### F-06: Skill Detail & Management
- Click any skill card to open a full detail panel
- View: rendered preview, raw source, file structure tree (SKILL.md, scripts/, references/)
- Actions: Edit, Duplicate, Delete (with confirmation), Export as ZIP, Copy to Clipboard
- Supporting files panel: list/view any files in the skill's subdirectory (scripts, reference docs)
- Rename skill (renames directory) with conflict detection

#### F-07: Search & Discovery
- Full-text search across all skill names, descriptions, and body content
- Search suggestions based on common task keywords
- Tag-based filtering (user-defined tags stored in skill frontmatter metadata field)
- "Recently used" section (tracked via localStorage)

#### F-08: Multi-Agent Compatibility View
- For each skill, display which agents it's confirmed compatible with based on folder location and frontmatter compatibility field[^5]
- "Install to Agent" helper: generate the correct `npx skills install` or `openskills install` command for the selected agent[^12]
- Copy-to-clipboard for install commands

#### F-09: Export & Portability
- Export single skill as `.zip` (correct directory structure with SKILL.md)
- Export all skills as single `.zip` archive
- Export skill as shareable Gist URL (generates GitHub Gist via API, optional)
- Import skill from ZIP or from URL (paste a raw SKILL.md URL)

***

### 5.2 Power Features (v1.1)

#### F-10: Bulk Operations
- Multi-select skills (checkbox mode)
- Bulk: Delete, Export, Tag, Move to subfolder

#### F-11: Version History (Local)
- On every save, append a timestamped snapshot to a `.skillforge/history/{skill-name}.jsonl` file in the skills folder
- "History" panel in editor: view diffs between versions, restore any version
- No external VCS required — fully local

#### F-12: Skill Templates Marketplace Browser
- Read-only browser of community skills from agentskills.io, GitHub anthropics/skills, and LobeHub marketplace[^23]
- Search by keyword (calls public APIs)
- One-click "Install to my library" — downloads and saves directly to local folder
- No account required for browsing; GitHub token optional for rate-limit avoidance

#### F-13: AI-Assisted Skill Writing (Bring Your Own Key)
- Optional "Generate with AI" button in the skill editor
- User provides their own API key (stored in localStorage, never transmitted except to chosen AI provider)
- Sends current skill context + best practices from spec to Claude/GPT-4 for suggestions
- Inline diff view: accept, reject, or edit individual suggestions
- Pre-fills description using the "start from real expertise" methodology[^22]

#### F-14: Skill Quality Scorer
- 5-dimension rating inspired by SkillHub's scoring system:[^1]
  1. **Specificity** — Are instructions concrete or vague?
  2. **Scope** — Is the skill appropriately scoped (not too broad/narrow)?[^22]
  3. **Completeness** — Are name, description, steps, and output spec all present?[^24]
  4. **Token Efficiency** — Is it under the 5,000-token budget?[^22]
  5. **Progressive Disclosure** — Are references properly offloaded to supporting files?[^6]
- Score shown as a numeric badge (0–100) on each card
- Detailed scoring breakdown in skill detail view with actionable improvement suggestions

#### F-15: Cross-Agent Sync Helper
- Detect multiple agent skill folders on the system (if user grants access to each)
- Show which skills exist in one location but not another
- "Sync to agent" — copy skill to another agent's folder with one click
- Solves the documented pain of skills being "locked" to one agent[^10]

#### F-16: Skill Collections
- Group skills into named collections (e.g., "Python Dev", "Writing", "Research")
- Collections are stored as a `.skillforge/collections.json` metadata file in the root skills folder
- Drag-and-drop collection management
- Export entire collection as a shareable ZIP

***

### 5.3 Built-in Skill Templates (Launch Library)

SkillForge ships with the following starter templates to eliminate blank-canvas anxiety:[^11]

| Template | Description | Category |
|---|---|---|
| Code Reviewer | Review code for quality, security, and standards | Development |
| Documentation Writer | Generate structured docs from code or specs | Development |
| PR Description Writer | Write PR summaries from git diffs | Development |
| Research Synthesizer | Gather and summarize info on a topic | Research |
| Meeting Notes Formatter | Convert raw notes into structured summaries | Productivity |
| Email Drafter | Draft professional emails from bullet points | Communication |
| Data Analyst | Clean, analyze, and summarize CSV/JSON data | Data |
| Brand Voice Writer | Write content following custom brand guidelines | Content |
| Weekly Standup Generator | Auto-generate standup summaries from work logs | Productivity |
| Blank (Advanced) | Empty template with frontmatter only | Meta |

Each template includes a pre-filled name, description, structured instructions, and an example output section — following the four-part template: description, inputs, process steps, output specification.[^24]

***

## 6. UX & Design Principles

### 6.1 Design Philosophy: Progressive Disclosure (UI mirrors the spec)

Just as skills themselves use progressive disclosure, SkillForge's UI uses the same principle: beginners see simple, guided flows — and complexity reveals itself only when needed.[^25]

- **Beginner entry point:** Wizard mode is the default. Advanced options are collapsed behind a "More options" expander.
- **Pro entry point:** A global "Pro Mode" toggle unlocks split-pane editing, bulk operations, and developer options.
- **No jargon in the UI:** "YAML frontmatter" becomes "Skill Info Fields." "Progressive disclosure" becomes "Keep instructions focused." Technical terms are always paired with plain-English tooltips.

### 6.2 Visual Design Requirements

- **Color system:** Clean, neutral base (white/off-white background) with a single brand accent color (e.g., electric indigo or teal)
- **Typography:** System font stack for maximum OS-native readability; monospace for code/YAML blocks
- **Skill cards:** Minimal, scannable — name large, description small, status indicator prominent
- **Iconography:** Agent logos (Claude, Codex, Cursor) displayed as small badges for instant agent-compatibility recognition
- **Responsive:** Works at full screen and in browser side-panel mode (minimum 600px width)
- **Dark mode:** Respects `prefers-color-scheme`
- **Accessibility:** WCAG 2.1 AA compliance — full keyboard navigation, ARIA labels on all interactive elements, minimum 4.5:1 contrast ratios

### 6.3 Onboarding Flow

```
Open SkillForge.html
       ↓
Welcome Screen (full-page)
  "Manage your AI agent skills visually"
  [Open Skills Folder]  ←  showDirectoryPicker()
       ↓
Folder scan (animated spinner, <1 second for <500 skills)
       ↓
Library Dashboard
  [if 0 skills] → "Create Your First Skill" hero CTA
  [if N skills] → Grid of skill cards with search/filter bar
```

First-time users with zero skills see a friendly empty state with:
1. A brief 3-sentence explainer of what agent skills are
2. Links to agent-specific quick-start paths ("Using Claude Code? Your folder is `~/.claude/skills`")
3. A prominent "Create Skill" button and a "Browse Templates" button

### 6.4 Micro-Interactions & Feedback

- Validation errors appear **inline** as the user types, not on submit
- Saved changes show a subtle "✓ Saved" toast (not a blocking modal)
- Destructive actions (delete) require a single confirmation click — no double-modal friction
- File write failures display a clear, actionable error ("Browser lost folder access — click to re-grant permission")
- Loading states use skeleton screens, never blocking spinners

***

## 7. Technical Architecture

### 7.1 File Operations Model

```
Browser (SkillForge.html)
  │
  ├── showDirectoryPicker() → FileSystemDirectoryHandle
  │     └── stored in localStorage (re-prompted on next open)
  │
  ├── READ: iterate entries → parse SKILL.md frontmatter → render cards
  │
  ├── WRITE: createWritable() on FileSystemFileHandle → save edited content
  │
  └── CREATE: getDirectoryHandle(name, {create:true}) → write SKILL.md
```

All file operations are async and wrapped in try/catch with user-friendly error messages. The app gracefully handles:
- Permission denied (user revoked access)
- Folder moved or renamed (re-prompt for new folder)
- Corrupt YAML frontmatter (display raw mode with error highlight)
- File system read-only scenarios

### 7.2 YAML Frontmatter Parsing

A minimal, inline YAML parser (< 4KB) handles the skill frontmatter format. No external YAML library is fetched at runtime — it is embedded in the HTML file. The parser supports:[^5]
- String values (name, description, license, compatibility)
- Key-value metadata mappings
- Space-delimited lists (allowed-tools)
- Graceful fallback for unrecognized keys

### 7.3 Performance Requirements

| Metric | Target |
|---|---|
| Initial render (0 skills) | < 200ms |
| Library render (100 skills) | < 1 second |
| Library render (1,000 skills) | < 3 seconds (virtualized list) |
| Save operation | < 500ms |
| Search response | < 100ms (client-side, no network) |
| Total HTML file size | < 500KB (all dependencies inlined) |

For large libraries (>200 skills), virtual scrolling must be implemented to avoid DOM bloat.

### 7.4 Data Persistence

| Data Type | Storage Location |
|---|---|
| Skill content | User's local filesystem (via File System API) |
| Folder handle | `localStorage` (permission re-requested on load) |
| User preferences (theme, pro mode) | `localStorage` |
| Collections metadata | `.skillforge/collections.json` in skills folder |
| Version history | `.skillforge/history/*.jsonl` in skills folder |
| API keys (optional) | `localStorage` (with clear warning in UI) |

No data is ever transmitted to any server. No telemetry, no analytics, no network requests unless the user explicitly triggers a marketplace browse or Gist export.

***

## 8. Compliance with the agentskills.io Specification

SkillForge enforces the official open standard at all points:[^26][^5]

### 8.1 Required Field Validation

| Field | Rule | SkillForge Behavior |
|---|---|---|
| `name` | Max 64 chars, `[a-z0-9-]`, no leading/trailing hyphen | Live counter + auto-slug generator |
| `description` | Max 1024 chars, non-empty | Live counter + quality hint |
| SKILL.md body | < 500 lines, < 5,000 tokens recommended[^22] | Line/token counter in status bar |

### 8.2 Optional Field Support

| Field | Description | UI Treatment |
|---|---|---|
| `license` | License name or reference | Dropdown with common OSS licenses |
| `compatibility` | Environment requirements (max 500 chars) | Text field with agent preset chips |
| `metadata` | Arbitrary key-value pairs | Dynamic key-value editor |
| `allowed-tools` | Space-delimited pre-approved tools | Tag input with autocomplete |

### 8.3 Directory Structure Support

SkillForge understands and renders the full skill directory structure:[^27][^25]

```
skill-name/
├── SKILL.md          ← Required; displayed as main editor
├── scripts/          ← Displayed in "Supporting Files" panel
│   └── helper.py
└── references/       ← Displayed in "Supporting Files" panel
    ├── template.md
    └── api-docs.md
```

Users can add, view, and delete supporting files from within the UI. Creating new supporting files and linking them from `SKILL.md` is supported via the "Add Supporting File" wizard.

***

## 9. Licensing

SkillForge is released under the **Apache License 2.0**.[^28]

The HTML file will include the following embedded license comment block at the top of the `<script>` section:

```
Copyright [YEAR] SkillForge Author

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    https://www.apache.org/licenses/LICENSE-2.0
```

A `LICENSE` file (full Apache 2.0 text) and a `NOTICE` file (copyright attribution) are included in the source repository. Third-party embedded libraries (YAML parser, Marked.js) must use compatible licenses (MIT, BSD, or Apache 2.0) and be attributed in the NOTICE file.[^29]

**Why Apache 2.0:**
- Automatically grants patent rights to users[^28]
- Permissive enough for enterprise adoption and embedding in commercial workflows
- Compatible with the open-standard ethos of agentskills.io itself[^30]
- Allows forks, extensions, and redistribution without "copyleft" obligations

***

## 10. Metrics & Success Criteria

### 10.1 v1.0 Launch Criteria (Definition of Done)

- [ ] Single `.html` file, < 500KB, no runtime CDN dependencies
- [ ] Opens and scans a local skills folder in < 1 second (100 skills)
- [ ] Creates a valid SKILL.md file via wizard in < 2 minutes for a first-time user
- [ ] Passes 100% of agentskills.io spec validation tests
- [ ] Works offline after initial download
- [ ] Passes WCAG 2.1 AA accessibility audit
- [ ] Apache 2.0 LICENSE file included in repository
- [ ] Tested on Chrome 120+, Edge 120+, Brave

### 10.2 Qualitative Success Signals (Post-launch)

- A non-technical user (no terminal experience) can create and save a working skill in under 5 minutes
- A developer managing 50+ skills reports the dashboard as their primary management interface
- Community forks adapt SkillForge for team/enterprise use cases
- Skills created with SkillForge pass validation in Claude Code, OpenAI Codex, and Cursor without modification

### 10.3 Tracked Metrics (Privacy-Preserving, Local-Only)

Since SkillForge has no backend, usage metrics are opt-in and stored only in localStorage:

| Metric | Purpose |
|---|---|
| Skills created count | Onboarding progress indicator |
| Validation errors encountered | Guide UI improvements |
| Templates used | Inform template library expansion |
| Pro mode toggle rate | Calibrate beginner/pro feature balance |

No data is sent anywhere. These metrics exist only to surface insights to the user themselves (e.g., "You've created 12 skills this month!").

***

## 11. Roadmap

### v1.0 — Foundation (MVP)
Core library view, wizard + pro editor, validation engine, import/export, F-01 through F-09.

### v1.1 — Power User *(merged into v1.0 MVP)*
Bulk operations, local version history, cross-agent sync helper, skill collections (F-10 through F-16). All power-user features ship at launch alongside the core experience.

### v1.2 — Discovery & Collaboration
Marketplace browser (read-only, no account), AI-assisted writing (BYOK), quality scorer.

### v2.0 — Ecosystem Integration *(MCP Server ships here)*
- **MCP server mode (ships at v2.0 launch):** Run SkillForge locally as an MCP endpoint, exposing skill CRUD operations so agents can self-manage their own skill library programmatically — no UI required for automation workflows
- Electron wrapper for users who prefer a native app feel
- GitHub Actions integration: validate skills in CI pipelines

***

## 12. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| File System API not available in Firefox/Safari | High | Medium | Show compatibility banner; offer export/import fallback for unsupported browsers |
| Browser revokes folder permission between sessions | Medium | Low | Graceful re-prompt with clear user messaging |
| Skills folder contains non-skill files/directories | Medium | Low | Skip directories without SKILL.md; show count of skipped items |
| Large skill libraries (5,000+) degrade performance | Low | High | Virtual scrolling + lazy frontmatter parsing |
| User accidentally deletes a skill | Medium | High | Soft-delete with 30-second undo toast; optional recycle bin in `.skillforge/trash/` |
| Open standard evolves and spec changes | Medium | Medium | Modular validation engine — update spec rules without touching UI code |
| Embedded dependencies increase file size | Medium | Low | Audit and tree-shake; target < 500KB |

***

## 13. Out of Scope (v1.0)

- Real-time collaboration or multi-user editing
- Cloud sync or cloud storage (all data stays local)
- A built-in AI agent runtime (this tool manages skills, not executes them)
- Mobile app (File System Access API is desktop-browser only)
- Installing skills directly into agents via CLI automation (generate install commands only)
- Billing, accounts, or any server-side component

***

## Appendix A: Competitive Landscape

| Tool | Format | Skill Awareness | Visual UI | Offline | Free/OSS |
|---|---|---|---|---|---|
| **SkillForge** | Single HTML | ✅ Full spec | ✅ Full | ✅ | ✅ Apache 2.0 |
| OpenSkills[^12] | CLI (npx) | ✅ Full spec | ❌ | ✅ | ✅ |
| akm CLI[^9] | CLI | ✅ | ❌ | ✅ | ✅ |
| SkillHub.club[^1] | Desktop App | ✅ | ✅ | ✅ | ❌ Paid tiers |
| openskill.online[^15] | Web App | ✅ | ✅ | ❌ | ❌ |
| PromptSmith[^14] | Docker | ❌ Skills only | ✅ | ✅ (self-hosted) | ✅ |

SkillForge's unique position: the only tool that is **simultaneously** visual, offline-capable, zero-install, local-first, free, and spec-compliant.

***

## Appendix B: Key References

- Agent Skills Open Standard: [agentskills.io/specification](https://agentskills.io/specification)[^5]
- Skill best practices: [agentskills.io/skill-creation/best-practices](https://agentskills.io/skill-creation/best-practices)[^22]
- Claude Code skills documentation: [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)[^31]
- Anthropic open standard announcement[^2]
- File System Access API: [developer.chrome.com](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)[^20]
- Apache 2.0 License: [apache.org/licenses/LICENSE-2.0](https://www.apache.org/licenses/LICENSE-2.0)[^28]

---

## References

1. [SkillHub solves agent skill discovery and management ...](https://www.linkedin.com/posts/keyuyuan-leo_skillhub-agent-skills-marketplace-activity-7420675076599017472-MnHF) - 2 weeks. 1,000 users. 100% week-over-week growth. 10% paying. No marketing. No ads. Cold start. Here...

2. [Anthropic Opens Agent Skills Standard, Continuing Its Pattern of ...](https://www.unite.ai/anthropic-opens-agent-skills-standard-continuing-its-pattern-of-building-industry-infrastructure/) - Anthropic published Agent Skills as an open standard on December 18, releasing the specification and...

3. [skill.md: An open standard for agent skills - Mintlify](https://www.mintlify.com/blog/skill-md) - skill.md is a markdown file that lives alongside your documentation, describing how best agents shou...

4. [Turn Any Agent Into an On-Demand Specialist with SKILL.md - LM-Kit](https://lm-kit.com/blog/agent-skills-explained/) - Agent Skills is an open specification for defining modular, reusable AI agent capabilities as self-c...

5. [Specification - Agent Skills](https://agentskills.io/specification) - Must be 1-1024 characters · Should describe both what the skill does and when to use it · Should inc...

6. [Agent Skills - Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) - Agent Skills are modular capabilities that extend Claude's functionality. Each Skill packages instru...

7. [Agent Skills: The Open Standard for AI Capabilities | blog](https://inference.sh/blog/skills/agent-skills-overview) - The SKILL.md format is universal. The metadata format is universal. The progressive disclosure patte...

8. [What’s the most painful part about building LLM agents? (memory, tools, infra?)](https://www.reddit.com/r/AI_Agents/comments/1kvw3kz/whats_the_most_painful_part_about_building_llm/) - What’s the most painful part about building LLM agents? (memory, tools, infra?)

9. [You Already Have Dozens of Agent Skills. You Just Can't Find Them.](https://dev.to/itlackey/you-already-have-dozens-of-agent-skills-you-just-cant-find-them-5bai) - Point it at a directory, and it indexes everything inside. Point it at five directories, and now you...

10. [I merged Perplexity Computer's 40+ skills with Claude Code's best ...](https://www.reddit.com/r/perplexity_ai/comments/1rk3j7f/i_merged_perplexity_computers_40_skills_with/) - Perplexity Computer is the most powerful AI agent most people will ever touch. Claude Code has the d...

11. [I built an open-source Claude Skill that recommends prompts from ...](https://www.reddit.com/r/ClaudeAI/comments/1qj1hse/i_built_an_opensource_claude_skill_that/) - I built an open-source Claude Skill that recommends prompts from 6000+ curated Nano Banana Pro promp...

12. [numman-ali/openskills: Universal skills loader for AI coding agents](https://github.com/numman-ali/openskills) - OpenSkills brings Anthropic's skills system to every AI coding agent — Claude Code, Cursor, Windsurf...

13. [skillfile - Manage AI skills and agents with a declarative approach.](https://www.pitchhut.com/project/skillfile) - skillfile simplifies the management of AI skills and agents, providing a single config file to track...

14. [I made an open source tool to manage AI prompts simply - Reddit](https://www.reddit.com/r/PromptEngineering/comments/1g3bdoj/i_made_an_open_source_tool_to_manage_ai_prompts/) - A prompt engineering solution to manage Gen AI prompts easily. Features RESTful API for easy integra...

15. [OpenSkill CLI | AI-Powered Skill Management for Claude](https://www.openskill.online) - AI-Powered Skill Management for Claude. Create and manage Claude skills with AI-powered content gene...

16. [HTML File - Single-File Web Apps (SFWAs for short) - gods.art](https://gods.art/articles/single_file_web_apps.html) - Since Single-File Web App have no external dependencies and require only a browser to run, they shou...

17. [The Single-File App Architecture: Why I Stopped Reaching for a ...](https://dev.to/clawgenesis/the-single-file-app-architecture-why-i-stopped-reaching-for-a-backend-15ej) - The Architecture: One File, No Build Step. When I built a job application tracker, I made a delibera...

18. [SingleFileApplication: TiddlyWiki v5.3.8 — a non-linear personal ...](https://tiddlywiki.com/static/SingleFileApplication.html) - TiddlyWiki is an unusual single file application because it stores its data within the same file, an...

19. [Getting Started With the File System Access API - CSS-Tricks](https://css-tricks.com/getting-started-with-the-file-system-access-api/) - The File System Access API is a web API that allows read and write access to a user's local files. I...

20. [The File System Access API: simplifying access to local files](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) - The File System Access API allows web apps to read or save changes directly to files and folders on ...

21. [File System API - MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) - Core functionality of this API includes reading files, writing or saving files, and access to direct...

22. [Best practices for skill creators - Agent Skills](https://agentskills.io/skill-creation/best-practices) - A common pitfall in skill creation is asking an LLM to generate a skill without providing domain-spe...

23. [페인 포인트 매니저 | Skills Marketplace - LobeHub](https://lobehub.com/ko/skills/nnnsightnnn-claudekit-pain-point-manager)

24. [Claude Code Skills Architecture: Why Your skill.md File Should Only ...](https://www.mindstudio.ai/blog/claude-code-skills-architecture-skill-md-reference-files) - The skill.md file is the entry point. It's what Claude Code reads first when a skill is invoked. Thi...

25. [How to Create AI Agent Skills (Complete tutorial) - YouTube](https://www.youtube.com/watch?v=WvBv6ASCt5E) - ... skills are under the hood, the directory conventions for different agents, and walk you through ...

26. [Agent Skills Specification — skills.menu](https://www.skills.menu/docs/specification) - The SKILL.md specification — frontmatter schema, directory structure, and validation rules for agent...

27. [The Complete Guide to CLAUDE.md, SKILL.md & Every Important ...](https://sidsaladi.substack.com/p/claude-codes-secret-weapon-the-complete) - This guide covers every important file in Claude Code's ecosystem, how to write each one well, and 6...

28. [Open Source Licenses 101: Apache License 2.0 | FOSSA Blog](https://fossa.com/blog/open-source-licenses-101-apache-license-2-0/) - An exploration of the Apache License 2.0, outlining its terms, use cases, and how it compares to oth...

29. [How to apply the Apache 2.0 License to your Open Source software ...](https://www.linkedin.com/pulse/how-apply-apache-20-license-your-open-source-software-vladim%C3%ADr-gorej) - To apply the license to your Open Source software project, create two files: LICENSE and NOTICE in t...

30. [skills/skills/killerapp/agentskills-io/SKILL.md at main - GitHub](https://github.com/openclaw/skills/blob/main/skills/killerapp/agentskills-io/SKILL.md) - Create, validate, and publish Agent Skills following the official open standard from agentskills.io....

31. [Extend Claude with skills - Claude Code Docs](https://code.claude.com/docs/en/skills) - Your SKILL.md can contain anything, but thinking through how you want the skill invoked (by you, by ...

