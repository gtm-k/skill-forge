---
name: daily-standup-prep
description: Generate concise standup updates from recent work activity, commits, and task boards. Use before daily standup meetings.
license: Apache-2.0
metadata:
  author: SkillForge Demo
  version: "1.0"
  tags: productivity, meetings, agile
allowed-tools: Bash Read
---
# Daily Standup Prep

Prepare a clear, concise standup update that respects everyone's time.

## Process

1. Review recent git commits and PR activity
2. Check task board for status changes
3. Identify blockers and dependencies
4. Draft the update in standard format

## Output Format

Keep each section to 2-4 bullet points. The entire update should take under 60 seconds to deliver.

### Done (since last standup)
- Completed items with context on outcome
- Reference PR/ticket numbers

### In Progress
- Current work items with percent estimate
- Expected completion

### Blocked
- What's waiting and on whom
- How long it's been blocked

### Heads Up
- Anything the team should know about
- Upcoming PTO, dependencies, risks

## Rules

- Be specific: "Fixed auth token refresh bug (#423)" not "Worked on bugs"
- Skip items that don't affect the team
- If nothing is blocked, say so — don't invent blockers
- Keep the whole update under 120 words
- Lead with the most important item
