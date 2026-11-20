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
5. Use [Conventional Commits](https://www.conventionalcommits.org/) for the PR title (`fix: …`, `feat: …`, `docs: …`). It becomes the squash commit and decides the next version (see below).

## Releases and automation

Releases are fully automated; nobody edits versions or the changelog by hand.

- **Commit messages / PR titles** follow [Conventional Commits](https://www.conventionalcommits.org/). PRs are squash-merged, so the PR title is the commit. `fix:` → patch, `feat:` → minor, a `!` before the colon (`feat!:`, `fix(api)!:`) → major. Squash commits use only the PR title, so the `!` is the way to flag a breaking change. `docs:`, `chore:`, `ci:`, `test:`, `refactor:` don't release.
- **release-please** keeps a `chore(main): release X.Y.Z` PR open with the next version and changelog (`CHANGELOG.md`, `package.json`, `server.json`). Merging it tags the release, creates the GitHub release and publishes to **npm** (trusted publishing, with provenance), **GHCR** (multi-arch image) and the **MCP Registry**.
- **ClickUp spec updates**: every Monday, `spec-drift` opens a PR with the regenerated tools, docs and counts, listing added/removed/renamed operations. Additive updates that pass the tests merge themselves, and so does the resulting release PR. Breaking ones are labelled `needs-review`.
- **Dependabot**: patch and minor updates merge themselves once CI passes; majors wait for review. Runtime dependency bumps (`fix(deps)`) ship as patch releases.
- **`main` is protected**: changes land through PRs with a green `CI OK` check (maintainers can bypass).

If a publish step fails, re-run it for an existing tag from **Actions → Release → Run workflow** with the `tag` input (each step skips what is already published).

## Reporting bugs and security issues

- Bugs and features: use the [issue forms](https://github.com/KelvinCampelo/clickup-full-mcp/issues/new/choose). Never include your API token.
- Security: follow [SECURITY.md](SECURITY.md) and report privately.
