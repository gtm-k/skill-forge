---
name: bug-report-triage
description: Analyze bug reports to assess severity, identify root cause, and suggest investigation steps. Use when new bug reports arrive or need prioritization.
license: Apache-2.0
metadata:
  author: SkillForge Demo
  version: "1.0"
  tags: support, triage, productivity
---
# Bug Report Triage

Quickly assess incoming bug reports and prepare them for engineering.

## Process

1. **Reproduce** — Identify the exact steps, inputs, and environment
2. **Classify severity** — How bad is this?
3. **Identify scope** — Who and what is affected?
4. **Suggest root cause** — Based on symptoms, where should engineers look?
5. **Recommend priority** — When should this be fixed?

## Severity Levels

| Level | Criteria | Response |
|-------|----------|----------|
| **P0 — Critical** | Data loss, security breach, full outage | Drop everything |
| **P1 — High** | Major feature broken, no workaround | Fix this sprint |
| **P2 — Medium** | Feature degraded, workaround exists | Schedule soon |
| **P3 — Low** | Minor issue, cosmetic, edge case | Backlog |

## Output Format

### Triage Summary

- **Title**: Clear, searchable summary
- **Severity**: P0 / P1 / P2 / P3
- **Affected Users**: Estimate scope (all users, specific plan, edge case)
- **Reproducible**: Always / Sometimes / Once / Unable to reproduce

### Root Cause Hypothesis

What likely went wrong and which component to investigate first.

### Recommended Actions

1. Immediate mitigation (if P0/P1)
2. Investigation steps for engineering
3. Monitoring to add

### Missing Information

What details are needed from the reporter to fully diagnose.
