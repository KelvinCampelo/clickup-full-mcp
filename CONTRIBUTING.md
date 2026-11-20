# Contributing

Thanks for helping improve **clickup-full-mcp**! Bug reports, docs fixes and pull requests are all welcome.
By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requirements: Node.js 20 or newer (24 recommended, see `.nvmrc`).

```bash
git clone https://github.com/KelvinCampelo/clickup-full-mcp.git
cd clickup-full-mcp
npm install        # installs deps and builds dist/
npm run check      # typecheck + Prettier + end-to-end tests
```

The tests start the real server over stdio, connect a real MCP client and point it at a local mock ClickUp API. No token or network access is needed.

To try your build in an MCP client, point the client at `node /path/to/clickup-full-mcp/dist/index.js` (see the README), then run `npm run build` after each change and restart the server from the client.

## Scripts

| Script                | What it does                                                               |
| --------------------- | -------------------------------------------------------------------------- |
| `npm run build`       | Compile `src/` to `dist/` and copy the generated operations.               |
| `npm test`            | Build, then run `test/e2e.mjs`.                                            |
| `npm run check`       | Everything CI runs: typecheck, format check, tests.                        |
| `npm run format`      | Apply Prettier.                                                            |
| `npm run generate`    | Regenerate `src/generated/operations.json` and `docs/tools/` from `spec/`. |
| `npm run update-spec` | Download the latest ClickUp specs into `spec/`, then regenerate.           |

## How the code is organised

```
spec/                      ClickUp's official OpenAPI specs (vendored, v2 JSON + v3 YAML)
scripts/generate.mjs       spec → src/generated/operations.json (one entry per tool)
scripts/generate-docs.mjs  operations.json → docs/tools/*.md (tool reference)
scripts/update-spec.mjs    downloads the latest specs
src/index.ts               MCP server: tool listing, full/meta modes, filters
src/client.ts              HTTP layer: auth, query encoding, uploads, retries, safety checks
src/config.ts              environment variable parsing and validation
test/e2e.mjs               MCP client ↔ server ↔ mock ClickUp tests
```

### Generated code

`src/generated/operations.json` and `docs/tools/` are **generated, but committed** so the server works and the docs render without running the generator. Don't edit them by hand:

- Wrong tool name, query encoding or upload field? Fix it in `scripts/generate.mjs` (`NAME_OVERRIDES`, `JSON_QUERY_PARAMS`, `UPLOAD_FIELD`, `queryStyle`), run `npm run generate` and commit the results.
- The tool docs layout lives in `scripts/generate-docs.mjs`, which also fails if any generated link is broken.
- CI fails if the committed files don't match what the generators produce from `spec/`.
- A scheduled workflow opens a PR when ClickUp publishes new specs.

## Pull requests

1. Open an issue first for larger changes so we can agree on the approach.
2. Keep PRs focused; one logical change per PR.
3. Add or update a check in `test/e2e.mjs` for any behaviour change. If you fixed a mismatch between the spec and the live API, describe how you verified the live behaviour.
4. Update `README.md` for user-facing changes and add a line under `## [Unreleased]` in `CHANGELOG.md`.
5. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and PR titles (`fix: …`, `feat: …`, `docs: …`, `chore(spec): …`).

## Releasing (maintainers)

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new version heading and update the compare links.
2. `npm version <patch|minor|major>`, which bumps `package.json`, commits and tags `vX.Y.Z`.
3. `git push --follow-tags`. The Release workflow runs the tests, checks that the tag matches `package.json`, and publishes a GitHub release with the changelog section as notes.

## Reporting bugs and security issues

- Bugs and features: use the [issue forms](https://github.com/KelvinCampelo/clickup-full-mcp/issues/new/choose). Never include your API token.
- Security: follow [SECURITY.md](SECURITY.md) and report privately.
