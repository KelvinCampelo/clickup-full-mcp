#!/usr/bin/env node
/**
 * Compares two operations.json files (before/after a ClickUp spec update) and reports what changed
 * for MCP clients: added, removed and renamed operations, and argument changes.
 *
 *   node scripts/diff-operations.mjs <before.json> <after.json> [--summary out.md]
 *
 * A change is "breaking" when an existing call could stop working: an operation is removed or renamed,
 * an argument is removed, or a new argument becomes required. In GitHub Actions it also writes
 * `breaking`, `added`, `has_changes` and `title` (a Conventional Commit title) to $GITHUB_OUTPUT.
 */
import fs from "node:fs";

const [beforeFile, afterFile] = process.argv.slice(2);
const summaryIdx = process.argv.indexOf("--summary");
const summaryFile = summaryIdx > 0 ? process.argv[summaryIdx + 1] : null;
if (!beforeFile || !afterFile) {
  console.error("usage: diff-operations.mjs <before.json> <after.json> [--summary out.md]");
  process.exit(2);
}

const load = (f) => new Map(JSON.parse(fs.readFileSync(f, "utf8")).map((o) => [o.name, o]));
const before = load(beforeFile);
const after = load(afterFile);
const endpoint = (o) => `${o.method} ${o.path}`;

let added = [...after.keys()].filter((n) => !before.has(n));
let removed = [...before.keys()].filter((n) => !after.has(n));

// Same endpoint or operationId under a new name = rename.
const renamed = [];
for (const oldName of [...removed]) {
  const o = before.get(oldName);
  const match = added.find((n) => endpoint(after.get(n)) === endpoint(o) || after.get(n).operationId === o.operationId);
  if (match) {
    renamed.push([oldName, match]);
    removed = removed.filter((n) => n !== oldName);
    added = added.filter((n) => n !== match);
  }
}

const changed = []; // { name, breaking, notes[] }
for (const [name, o] of before) {
  const n = after.get(name);
  if (!n) continue;
  const notes = [];
  let breaking = false;
  const oldArgs = new Set(Object.keys(o.inputSchema.properties));
  const newArgs = new Set(Object.keys(n.inputSchema.properties));
  const oldReq = new Set(o.inputSchema.required || []);
  const newReq = new Set(n.inputSchema.required || []);
  const gone = [...oldArgs].filter((a) => !newArgs.has(a));
  const fresh = [...newArgs].filter((a) => !oldArgs.has(a));
  const nowRequired = [...newReq].filter((a) => !oldReq.has(a));
  if (endpoint(o) !== endpoint(n)) notes.push(`endpoint ${endpoint(o)} → ${endpoint(n)}`);
  if (gone.length) ((breaking = true), notes.push(`removed args: ${gone.join(", ")}`));
  if (nowRequired.length) ((breaking = true), notes.push(`newly required: ${nowRequired.join(", ")}`));
  if (fresh.length) notes.push(`new args: ${fresh.join(", ")}`);
  if (!notes.length && JSON.stringify(o.inputSchema) !== JSON.stringify(n.inputSchema)) notes.push("schema details");
  if (!notes.length && o.description !== n.description) notes.push("description");
  if (notes.length) changed.push({ name, breaking, notes });
}

const breaking = removed.length > 0 || renamed.length > 0 || changed.some((c) => c.breaking);
const hasChanges = added.length + removed.length + renamed.length + changed.length > 0;
// feat → minor release, fix → patch release, chore → no release (nothing user-visible changed).
const type = breaking ? "feat(spec)!" : added.length ? "feat(spec)" : hasChanges ? "fix(spec)" : "chore(spec)";
const title = `${type}: ${
  added.length
    ? `add ${added.length} ClickUp operation${added.length > 1 ? "s" : ""}`
    : hasChanges
      ? "update ClickUp operations"
      : "refresh ClickUp OpenAPI specs"
}${breaking ? " (breaking changes)" : ""}`;

const list = (items) => items.map((x) => `- ${x}`).join("\n");
const md = [
  `**Operations:** ${before.size} → ${after.size}${breaking ? " · ⚠️ **contains breaking changes, review required**" : " · ✅ additive only"}`,
  added.length &&
    `### Added (${added.length})\n${list(added.map((n) => `\`${n}\`: ${after.get(n).summary} (\`${endpoint(after.get(n))}\`)`))}`,
  removed.length && `### Removed (${removed.length}) ⚠️\n${list(removed.map((n) => `\`${n}\` (\`${endpoint(before.get(n))}\`)`))}`,
  renamed.length && `### Renamed (${renamed.length}) ⚠️\n${list(renamed.map(([a, b]) => `\`${a}\` → \`${b}\``))}`,
  changed.length &&
    `### Changed (${changed.length})\n${list(changed.map((c) => `\`${c.name}\`${c.breaking ? " ⚠️" : ""}: ${c.notes.join("; ")}`))}`,
  !hasChanges && "No tool changes: the spec update only touched content that doesn't affect the generated tools.",
]
  .filter(Boolean)
  .join("\n\n");

console.log(md);
if (summaryFile) fs.writeFileSync(summaryFile, md + "\n");
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `breaking=${breaking}\nadded=${added.length}\nhas_changes=${hasChanges}\ntitle=${title}\n`);
}
