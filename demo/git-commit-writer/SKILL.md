---
name: git-commit-writer
description: Generate clear, conventional commit messages from staged changes. Use when committing code to produce well-structured git history.
license: Apache-2.0
metadata:
  author: SkillForge Demo
  version: "1.0"
  tags: development, git, productivity
allowed-tools: Bash
---
# Git Commit Writer

Generate commit messages that follow the Conventional Commits specification.

## Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

## Types

| Type | When to use |
|------|-------------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, whitespace (no code change) |
| `refactor` | Code restructuring (no behavior change) |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `ci` | CI/CD configuration |
| `chore` | Maintenance, dependencies |

## Rules

- Subject line: imperative mood, lowercase, no period, max 72 characters
- Scope: the module, component, or area affected (optional but preferred)
- Body: explain *what* and *why*, not *how* — wrap at 72 characters
- Footer: reference issue numbers (`Closes #123`) or note breaking changes (`BREAKING CHANGE:`)
- One logical change per commit — split unrelated changes

## Examples

```
feat(auth): add OAuth2 PKCE flow for mobile clients

Implements the authorization code flow with PKCE extension
for native mobile apps. This replaces the implicit grant
which is no longer recommended per OAuth 2.1 draft.

Closes #847
```

```
fix(parser): handle empty YAML frontmatter without crashing

The YAML parser threw TypeError when frontmatter was present
but empty (just `---\n---`). Now returns an empty object.
```
