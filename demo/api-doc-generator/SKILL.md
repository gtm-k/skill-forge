---
name: api-doc-generator
description: Generate structured API documentation from source code, OpenAPI specs, or endpoint descriptions. Use when creating or updating API reference docs.
license: Apache-2.0
metadata:
  author: SkillForge Demo
  version: "1.0"
  tags: documentation, api, development
allowed-tools: Bash Read Write
---
# API Documentation Generator

Create clear, developer-friendly API documentation that helps consumers integrate quickly.

## Process

1. **Identify endpoints** — method, path, purpose
2. **Document parameters** — path, query, header, body with types and constraints
3. **Describe responses** — status codes, response schemas, error formats
4. **Add examples** — realistic request/response pairs for every endpoint
5. **Note authentication** — what's required and how to provide it

## Output Format

For each endpoint:

### `METHOD /path`

> Brief description of what this endpoint does.

**Authentication**: Required / Optional / None

**Parameters**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|

**Request Body** (if applicable)
```json
{ "example": "payload" }
```

**Responses**

| Status | Description |
|--------|-------------|
| 200 | Success — returns ... |
| 400 | Validation error |
| 401 | Unauthorized |
| 404 | Resource not found |

**Example**
```bash
curl -X GET https://api.example.com/v1/resource \
  -H "Authorization: Bearer <token>"
```

## Rules

- Use realistic example values, not "string" or "foo"
- Document every error status code the endpoint can return
- Include rate limit information if applicable
- Group related endpoints under resource headings
- Note deprecated fields with migration guidance
