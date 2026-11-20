// Tests for the spec-update tooling that decides whether a ClickUp spec PR can be auto-merged.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const ops = JSON.parse(fs.readFileSync(new URL("../src/generated/operations.json", import.meta.url), "utf8"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clickup-scripts-"));
const write = (name, data) => (fs.writeFileSync(path.join(dir, name), JSON.stringify(data)), path.join(dir, name));
const clone = () => JSON.parse(JSON.stringify(ops));
const before = write("before.json", ops);

function diff(after) {
  const out = path.join(dir, "out.txt");
  fs.writeFileSync(out, "");
  execFileSync(process.execPath, ["scripts/diff-operations.mjs", before, after], {
    env: { ...process.env, GITHUB_OUTPUT: out },
    stdio: "pipe",
  });
  return Object.fromEntries(
    fs
      .readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}
let passed = 0;
const ok = (msg) => (passed++, console.log("  ✓", msg));

let r = diff(write("same.json", ops));
assert.deepEqual([r.breaking, r.has_changes, r.title.startsWith("chore(spec):")], ["false", "false", true]);
ok("no tool changes → chore(spec), which doesn't trigger a release");

const added = clone();
added.push({
  ...clone().find((o) => o.name === "get_task"),
  name: "get_task_followers",
  operationId: "GetTaskFollowers",
  path: "/api/v2/task/{task_id}/followers",
});
const optionalArg = added.find((o) => o.name === "get_tasks");
optionalArg.inputSchema.properties.new_filter = { type: "string" };
r = diff(write("added.json", added));
assert.deepEqual([r.breaking, r.added, r.title], ["false", "1", "feat(spec): add 1 ClickUp operation"]);
ok("new operation + new optional argument → additive feat(spec)");

const removed = clone().filter((o) => o.name !== "delete_webhook");
assert.equal(diff(write("removed.json", removed)).breaking, "true");
const renamed = clone();
renamed.find((o) => o.name === "get_spaces").name = "list_spaces";
assert.equal(diff(write("renamed.json", renamed)).breaking, "true");
const required = clone();
required.find((o) => o.name === "get_tasks").inputSchema.required.push("page");
r = diff(write("required.json", required));
assert.deepEqual([r.breaking, r.title.startsWith("feat(spec)!:")], ["true", true]);
ok("removed / renamed operation or newly required argument → breaking feat(spec)!");

const described = clone();
described[0].description += " More details.";
r = diff(write("described.json", described));
assert.deepEqual([r.breaking, r.has_changes, r.title.startsWith("fix(spec):")], ["false", "true", true]);
ok("description-only change → fix(spec)");

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nAll ${passed} script checks passed.`);
