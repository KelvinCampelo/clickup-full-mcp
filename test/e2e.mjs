// End-to-end test: real MCP client <-> this server over stdio, with a local mock ClickUp API.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const seen = [];
let rateLimitOnce = true;
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      ua: req.headers["user-agent"],
      ct: req.headers["content-type"] || "",
      body,
    });
    if (req.url.startsWith("/api/v2/ratelimit")) {
      if (rateLimitOnce) {
        rateLimitOnce = false;
        res.writeHead(429, { "retry-after": "1" });
        return res.end('{"err":"Rate limit"}');
      }
    }
    if (req.url.startsWith("/api/v2/task/missing")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end('{"err":"Task not found","ECODE":"ITEM_015"}');
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, echo: req.url }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    // Most suites call typed tools directly, so they run in full mode unless they ask otherwise.
    env: { PATH: process.env.PATH, CLICKUP_BASE_URL: base, CLICKUP_API_TOKEN: "pk_test_123", CLICKUP_TOOL_MODE: "full", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(transport);
  return client;
}
const last = () => seen[seen.length - 1];
let passed = 0;
const ok = (msg) => (passed++, console.log("  ✓", msg));

// ---------- full mode ----------
let c = await connect({});
const { tools } = await c.listTools();
const opCount = JSON.parse(fs.readFileSync(new URL("../src/generated/operations.json", import.meta.url), "utf8")).length;
assert.ok(opCount >= 150, `expected the full API, got ${opCount} operations`);
assert.equal(tools.length, opCount + 1, "every operation + clickup_request");
ok(`full mode lists ${tools.length} tools`);
for (const t of tools) assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);
for (const t of tools)
  for (const k of Object.keys(t.inputSchema.properties || {})) assert.match(k, /^[a-zA-Z0-9_.-]{1,64}$/, `${t.name}.${k}`);
ok("all tool names and argument keys are client-safe");
assert.ok(tools.find((t) => t.name === "delete_task").annotations.destructiveHint);
assert.ok(tools.find((t) => t.name === "get_task").annotations.readOnlyHint);
ok("annotations (readOnly / destructive) set");

let r = await c.callTool({ name: "get_authorized_user", arguments: {} });
assert.equal(last().url, "/api/v2/user");
assert.equal(last().auth, "pk_test_123");
assert.equal(last().ua, `${pkg.name}/${pkg.version}`);
ok("v2 GET path + personal token header + versioned User-Agent");

r = await c.callTool({
  name: "get_tasks",
  arguments: {
    list_id: "901",
    statuses: ["to do", "in progress"],
    assignees: [1, 2],
    include_closed: true,
    custom_fields: [{ field_id: "f1", operator: "=", value: "x" }],
    page: 0,
  },
});
const u = new URL(last().url, base);
assert.equal(u.pathname, "/api/v2/list/901/task");
assert.deepEqual(u.searchParams.getAll("statuses[]"), ["to do", "in progress"]);
assert.deepEqual(u.searchParams.getAll("assignees[]"), ["1", "2"]);
assert.equal(u.searchParams.get("include_closed"), "true");
assert.deepEqual(JSON.parse(u.searchParams.get("custom_fields")), [{ field_id: "f1", operator: "=", value: "x" }]);
assert.equal(u.searchParams.get("page"), "0");
ok("get_tasks: bracket arrays, JSON custom_fields, booleans, zero values");

r = await c.callTool({ name: "get_user_groups", arguments: { team_id: "7", group_ids: ["A", "B"] } });
assert.deepEqual(new URL(last().url, base).searchParams.getAll("group_ids"), ["A", "B"]);
ok("get_user_groups: repeated-key arrays");

r = await c.callTool({ name: "create_task", arguments: { list_id: "901", body: { name: "Hello", priority: 2, assignees: [1] } } });
assert.equal(last().method, "POST");
assert.equal(last().url, "/api/v2/list/901/task");
assert.match(last().ct, /application\/json/);
assert.deepEqual(JSON.parse(last().body), { name: "Hello", priority: 2, assignees: [1] });
ok("create_task: JSON body");

r = await c.callTool({
  name: "update_time_entry",
  arguments: { team_id: "7", timer_id: "t1", query_team_id: 7, custom_task_ids: true, body: { description: "x" } },
});
assert.equal(new URL(last().url, base).pathname, "/api/v2/team/7/time_entries/t1");
assert.equal(new URL(last().url, base).searchParams.get("team_id"), "7");
ok("update_time_entry: path/query name collision handled");

r = await c.callTool({ name: "get_doc_pages", arguments: { workspace_id: 55, doc_id: "d 1" } });
assert.match(last().url, /^\/api\/v3\/workspaces\/55\/docs\/d%201\/pages/);
ok("v3 path + URL-encoding of path params");

const tmp = path.join(os.tmpdir(), "clickup-e2e.txt");
fs.writeFileSync(tmp, "hello attachment");
r = await c.callTool({ name: "create_task_attachment", arguments: { task_id: "abc", file_path: tmp } });
assert.match(last().ct, /multipart\/form-data/);
assert.match(last().body, /name="attachment"; filename="clickup-e2e.txt"/);
assert.match(last().body, /hello attachment/);
ok("v2 attachment upload: multipart field 'attachment' from local file");

r = await c.callTool({
  name: "create_attachment",
  arguments: {
    workspace_id: 1,
    entity_type: "attachments",
    entity_id: "abc",
    file_base64: Buffer.from("b64data").toString("base64"),
    file_name: "x.txt",
    form_fields: { filename: "renamed.txt" },
  },
});
assert.match(last().body, /name="file"; filename="x.txt"/);
assert.match(last().body, /name="filename"\r\n\r\nrenamed.txt/);
ok("v3 attachment upload: field 'file' from base64 + extra form fields");

r = await c.callTool({ name: "get_access_token", arguments: { body: { client_id: "a", client_secret: "b", code: "c" } } });
assert.equal(last().auth, undefined);
assert.deepEqual(JSON.parse(last().body), { client_id: "a", client_secret: "b", code: "c" });
ok("get_access_token: OAuth code exchange sent without Authorization header");

r = await c.callTool({ name: "get_task", arguments: { task_id: "missing" } });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /HTTP 404[\s\S]*ITEM_015/);
ok("API errors surface as isError with status + ClickUp ECODE");

const before = seen.length;
r = await c.callTool({ name: "create_task", arguments: { body: { name: "x" } } });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /Missing required argument.*list_id/);
r = await c.callTool({ name: "create_task", arguments: { list_id: "1", name: "x" } });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /Unknown argument.*name[\s\S]*inside `body`/);
assert.equal(seen.length, before, "no HTTP call on validation errors");
ok("argument validation: missing required / misplaced body fields");

r = await c.callTool({ name: "clickup_request", arguments: { method: "GET", path: "/v2/ratelimit", query: { "tags[]": ["a", "b"] } } });
assert.ok(!r.isError);
assert.equal(new URL(last().url, base).searchParams.getAll("tags[]").length, 2);
ok("clickup_request: raw call + 429 retry honoured Retry-After");
r = await c.callTool({ name: "clickup_request", arguments: { method: "GET", path: "https://evil.example/x" } });
assert.equal(r.isError, true);
for (const bad of [
  "//evil.example/api/v2/x",
  "/api/v2/../../admin",
  "/api/v2/%2e%2e/%2E%2E/admin",
  "/api/v2\\..\\..\\admin",
  "/api/v4/x",
  "file:///etc/passwd",
]) {
  const n = seen.length;
  r = await c.callTool({ name: "clickup_request", arguments: { method: "GET", path: bad } });
  assert.equal(r.isError, true, `should reject ${bad}`);
  assert.equal(seen.length, n, `no HTTP call for ${bad}`);
}
ok("clickup_request: refuses other hosts, path traversal (.., %2e%2e, backslashes) and non-API prefixes");
r = await c.callTool({ name: "clickup_request", arguments: { method: "GET", path: "/api/v2/team?archived=true", query: { page: 1 } } });
assert.equal(new URL(last().url, base).pathname, "/api/v2/team");
assert.deepEqual(Object.fromEntries(new URL(last().url, base).searchParams), { archived: "true", page: "1" });
ok("clickup_request: query string in path is merged with `query`");
await c.close();

// ---------- upload roots ----------
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clickup-e2e-")));
const allowed = path.join(sandbox, "allowed");
fs.mkdirSync(allowed);
fs.writeFileSync(path.join(allowed, "ok.txt"), "inside");
const outside = path.join(sandbox, "secret.txt");
fs.writeFileSync(outside, "outside");
let symlinkMade = false;
try {
  fs.symlinkSync(outside, path.join(allowed, "link.txt"));
  symlinkMade = true;
} catch {
  /* Windows without symlink privilege */
}
c = await connect({ CLICKUP_UPLOAD_ROOTS: allowed });
r = await c.callTool({ name: "create_task_attachment", arguments: { task_id: "abc", file_path: path.join(allowed, "ok.txt") } });
assert.ok(!r.isError, r.content[0].text);
assert.match(last().body, /inside/);
r = await c.callTool({ name: "create_task_attachment", arguments: { task_id: "abc", file_path: outside } });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /outside the allowed upload folders/);
r = await c.callTool({ name: "create_task_attachment", arguments: { task_id: "abc", file_path: path.join(allowed, "..", "secret.txt") } });
assert.equal(r.isError, true);
if (symlinkMade) {
  r = await c.callTool({ name: "create_task_attachment", arguments: { task_id: "abc", file_path: path.join(allowed, "link.txt") } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /outside the allowed upload folders/);
}
ok(`CLICKUP_UPLOAD_ROOTS: allows inside, blocks outside / ..${symlinkMade ? " / symlink escape" : " (symlink check skipped)"}`);
await c.close();
fs.rmSync(sandbox, { recursive: true, force: true });

// ---------- OAuth bearer + default workspace ----------
c = await connect({ CLICKUP_API_TOKEN: "oauth_abc", CLICKUP_WORKSPACE_ID: "999" });
const t2 = (await c.listTools()).tools.find((t) => t.name === "get_spaces");
assert.ok(!(t2.inputSchema.required || []).includes("team_id"));
await c.callTool({ name: "get_spaces", arguments: {} });
assert.equal(new URL(last().url, base).pathname, "/api/v2/team/999/space");
assert.equal(last().auth, "Bearer oauth_abc");
ok("OAuth token -> Bearer; CLICKUP_WORKSPACE_ID auto-fills team_id");
await c.close();

// ---------- filters ----------
c = await connect({ CLICKUP_TOOLSETS: "tasks,comments", CLICKUP_READ_ONLY: "true" });
const names = (await c.listTools()).tools.map((t) => t.name);
assert.ok(names.includes("get_tasks") && names.includes("get_task_comments"));
assert.ok(!names.includes("create_task") && !names.includes("get_spaces"));
r = await c.callTool({ name: "clickup_request", arguments: { method: "DELETE", path: "/api/v2/task/1" } });
assert.equal(r.isError, true);
ok(`toolsets + read-only filter (${names.length} tools), raw writes blocked`);
await c.close();

// ---------- meta mode (the default when CLICKUP_TOOL_MODE is unset) ----------
c = await connect({ CLICKUP_TOOL_MODE: "" });
const metaNames = (await c.listTools()).tools.map((t) => t.name);
assert.deepEqual(metaNames.sort(), [
  "clickup_call_operation",
  "clickup_describe_operation",
  "clickup_request",
  "clickup_search_operations",
]);
r = await c.callTool({ name: "clickup_search_operations", arguments: { query: "time entry start" } });
assert.match(r.content[0].text, /start_time_entry/);
const top = async (query) =>
  JSON.parse((await c.callTool({ name: "clickup_search_operations", arguments: { query, limit: 3 } })).content[0].text)[0].name;
assert.equal(await top("create task"), "create_task");
assert.equal(await top("send chat message"), "send_chat_message");
assert.equal(await top("tasks"), "get_tasks");
assert.equal(await top("start timer"), "start_time_entry");
assert.equal(await top("log time"), "create_time_entry");
assert.equal(await top("doc pages"), "get_doc_pages");
r = await c.callTool({ name: "clickup_describe_operation", arguments: { name: "create_task" } });
assert.match(r.content[0].text, /"list_id"/);
r = await c.callTool({
  name: "clickup_call_operation",
  arguments: { name: "start_time_entry", arguments: { team_Id: "7", body: { tid: "abc" } } },
});
assert.equal(new URL(last().url, base).pathname, "/api/v2/team/7/time_entries/start");
ok("meta mode is the default: 4 tools, search -> describe -> call");
await c.close();

// ---------- CLI ----------
const v = spawnSync(process.execPath, ["dist/index.js", "--version"], { encoding: "utf8" });
assert.equal(v.status, 0);
assert.equal(v.stdout.trim(), pkg.version);
const bad = spawnSync(process.execPath, ["dist/index.js"], {
  encoding: "utf8",
  env: { PATH: process.env.PATH, CLICKUP_TIMEOUT_MS: "soon" },
  input: "",
});
assert.equal(bad.status, 1);
assert.match(bad.stderr, /Configuration error: CLICKUP_TIMEOUT_MS must be a number/);
ok("--version, and invalid config exits 1 with a clear message");

mock.close();
console.log(`\nAll ${passed} checks passed.`);
