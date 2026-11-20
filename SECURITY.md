# Security Policy

## Supported versions

Security fixes land on the latest release line. Please upgrade to the newest version before reporting.

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |
| < 1.0   | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: **[Security → Report a vulnerability](https://github.com/KelvinCampelo/clickup-full-mcp/security/advisories/new)**.

Include what you found, how to reproduce it, and the impact you expect. You can expect an acknowledgement within 7 days. Fixes are released as a patch version and credited in the advisory unless you prefer otherwise.

## Scope

This server runs locally and holds a ClickUp API token with the full permissions of the account that issued it. Issues we particularly care about:

- The token being sent anywhere other than `CLICKUP_BASE_URL`, or leaking into logs or tool output.
- `clickup_request` reaching paths outside `/api/v2/` and `/api/v3/`, or other hosts.
- `file_path` uploads reading files outside `CLICKUP_UPLOAD_ROOTS` when it is set.
- `CLICKUP_READ_ONLY=true` still allowing writes.

Out of scope: behaviour of the ClickUp API itself (report those to ClickUp), and actions an MCP client performs because a user or model asked it to with a correctly scoped configuration.

## Hardening tips for users

- Start with `CLICKUP_READ_ONLY=true` and widen access only when needed.
- Limit exposed tools with `CLICKUP_TOOLSETS` and `CLICKUP_DISABLED_TOOLS` (e.g. hide `delete_*`).
- Set `CLICKUP_UPLOAD_ROOTS` so uploads can only read from specific folders.
- Keep the token in your MCP client's env config, never in a file you commit.
- Treat ClickUp content (task descriptions, comments, docs) as untrusted input to the model: it can contain prompt-injection attempts. Keep your client's per-tool confirmation on for write and delete tools.
