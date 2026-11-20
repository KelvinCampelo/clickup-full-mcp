# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-11-20

### Changed

- **Breaking: meta mode is now the default.** With no `CLICKUP_TOOL_MODE` set, the server exposes 4 tools that reach all 173 operations (~700 tokens of context). Set `CLICKUP_TOOL_MODE=full` for the previous behaviour of one tool per endpoint.

### Added

- Published to npm: run with `npx -y clickup-full-mcp`.
- Listed in the official MCP Registry as `io.github.KelvinCampelo/clickup-full-mcp` (`server.json`).
- Release workflow publishes to npm with provenance (trusted publishing) and to the MCP Registry on every version tag.

## [1.0.0] - 2026-11-20

First public release.

### Added

- MCP server (stdio) exposing all 173 ClickUp API operations (v2 + v3) as tools, generated from ClickUp's official OpenAPI specs.
- `meta` mode: 4 tools (`clickup_search_operations`, `clickup_describe_operation`, `clickup_call_operation`, `clickup_request`) that reach every operation for ~700 tokens of context, and `full` mode with one tool per endpoint.
- Operation search ranks name matches above summary, path and description matches, and understands everyday verbs ("log time" → `create_time_entry`, "post message" → `send_chat_message`).
- Filters: `CLICKUP_TOOLSETS`, `CLICKUP_READ_ONLY`, `CLICKUP_DISABLED_TOOLS`.
- `clickup_request` raw tool for any `/api/v2` or `/api/v3` path.
- Default workspace (`CLICKUP_WORKSPACE_ID`) auto-filled into `team_id` / `workspace_id`.
- File uploads from a local path or base64, optionally restricted with `CLICKUP_UPLOAD_ROOTS`.
- 429 retries honouring `Retry-After` / `X-RateLimit-Reset`; request timeouts; large-response truncation.
- Personal tokens and OAuth access tokens (sent as `Bearer`), plus `get_access_token` for the OAuth code exchange.
- `--version` flag.
- Generated tool reference in `docs/tools/` (one page per toolset, with arguments and body fields), kept in sync with the specs by `npm run generate` and CI.

### Security

- `clickup_request` normalizes paths before checking them, so `..`, `%2e%2e` and backslash traversal can't leave `/api/v2` / `/api/v3`.
- `CLICKUP_UPLOAD_ROOTS` checks resolve symlinks, so a link inside an allowed folder can't expose files outside it.
- Invalid numeric or URL settings now fail at startup with a clear message instead of misbehaving at runtime.

[Unreleased]: https://github.com/KelvinCampelo/clickup-full-mcp/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/KelvinCampelo/clickup-full-mcp/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/KelvinCampelo/clickup-full-mcp/releases/tag/v1.0.0
