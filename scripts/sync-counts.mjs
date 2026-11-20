#!/usr/bin/env node
/**
 * Keeps the operation counts quoted in README.md, package.json, server.json and llms.txt in sync with
 * src/generated/operations.json, so a ClickUp spec update never leaves stale numbers behind.
 * Only numbers in known phrases are touched. Run via `npm run generate`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ops = JSON.parse(fs.readFileSync(path.join(root, "src/generated/operations.json"), "utf8"));
const total = ops.length;
const v2 = ops.filter((o) => o.version === "v2").length;
const v3 = ops.filter((o) => o.version === "v3").length;
const byToolset = {};
for (const o of ops) byToolset[o.toolset] = (byToolset[o.toolset] || 0) + 1;

/** Replace a number inside a fixed-width table cell, keeping the cell width (right-aligned). */
const padCell = (cell, n) => {
  const width = cell.length;
  const text = ` ${n} `;
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
};

const edits = {
  "README.md": (s) =>
    s
      .replace(/\b\d{2,4}(?= (?:ClickUp API operations|operations|tool schemas|endpoints are registered)\b)/g, String(total))
      .replace(/\b\d+ v2 \+ \d+ v3\b/g, `${v2} v2 + ${v3} v3`)
      // "Why 4 tools?" table: full-mode tool count = every operation + clickup_request
      .replace(/^(\| `full` \(`CLICKUP_TOOL_MODE=full`\)\s*\|)([^|]+)\|/m, (m, label, cell) => `${label}${padCell(cell, total + 1)}|`)
      // Toolset list (one line, each entry links to its generated reference page)
      .replace(
        /^\[`[a-z_]+`\]\(docs\/tools\/[a-z_]+\.md\) \(\d+\)(?: · \[`[a-z_]+`\]\(docs\/tools\/[a-z_]+\.md\) \(\d+\))*$/m,
        Object.keys(byToolset)
          .sort()
          .map((t) => `[\`${t}\`](docs/tools/${t}.md) (${byToolset[t]})`)
          .join(" · "),
      ),
  "package.json": (s) => s.replace(/all \d+ v2 \+ v3 operations/, `all ${total} v2 + v3 operations`),
  "server.json": (s) => s.replace(/\(\d+ v2\+v3 operations\)/, `(${total} v2+v3 operations)`),
  "llms.txt": (s) => s.replace(/all \d+ operations of ClickUp API v2/, `all ${total} operations of ClickUp API v2`),
};

const changed = [];
for (const [file, edit] of Object.entries(edits)) {
  const p = path.join(root, file);
  const before = fs.readFileSync(p, "utf8");
  const after = edit(before);
  if (after !== before) {
    fs.writeFileSync(p, after);
    changed.push(file);
  }
}
console.log(
  `Counts: ${total} operations (${v2} v2 + ${v3} v3)${changed.length ? `; updated ${changed.join(", ")}` : "; all files already in sync"}`,
);
