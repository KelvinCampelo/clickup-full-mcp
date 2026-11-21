#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { ClickUpClient, UserError, isWorkspaceKey, type ApiResult, type Operation } from "./client.js";
import { PACKAGE_NAME, VERSION } from "./version.js";
import { renderJson, renderMeta } from "./format.js";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`${PACKAGE_NAME} v${VERSION}
Complete ClickUp API (v2 + v3) MCP server. Speaks MCP over stdio.

Usage:
  ${PACKAGE_NAME} [--help | -h] [--version | -v]

Environment variables:
  CLICKUP_API_TOKEN          ClickUp personal token (pk_...) or OAuth access token (required)
  CLICKUP_WORKSPACE_ID       Default Workspace ID, auto-filled for team_id / workspace_id
  CLICKUP_TOOL_MODE          "meta" (4 tools, default) or "full" (one tool per operation)
  CLICKUP_TOOLSETS           Comma-separated toolsets to expose (default: all)
  CLICKUP_READ_ONLY          "true" to allow only GET operations
  CLICKUP_DISABLED_TOOLS     Comma-separated operation names to hide
  CLICKUP_ENABLE_RAW_REQUEST Expose the clickup_request raw-call tool
  CLICKUP_UPLOAD_ROOTS       Folders file_path uploads may read from
  CLICKUP_RESPONSE_FORMAT    "compact" (default), "json" or "pretty"
  CLICKUP_MAX_RESPONSE_CHARS Truncate responses longer than this
  CLICKUP_TIMEOUT_MS         Request timeout in milliseconds
  CLICKUP_MAX_RETRIES        Retries on 429 / transient errors
  CLICKUP_BASE_URL           Override the ClickUp API host

Docs: https://github.com/KelvinCampelo/clickup-full-mcp#readme`);
  process.exit(0);
}

const ALL_OPS: Operation[] = JSON.parse(readFileSync(new URL("./generated/operations.json", import.meta.url), "utf8"));

let cfg: Config;
try {
  cfg = loadConfig();
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`[clickup-mcp] Configuration error: ${e.message}`);
  process.exit(1);
}
const client = new ClickUpClient(cfg);

/** Operations visible under the current config (toolsets, read-only, disabled list). */
function enabledOps(c: Config): Operation[] {
  return ALL_OPS.filter(
    (op) => (!c.toolsets || c.toolsets.has(op.toolset)) && (!c.readOnly || op.method === "GET") && !c.disabledTools.has(op.name),
  );
}
const OPS = enabledOps(cfg);
const OPS_BY_NAME = new Map(OPS.map((o) => [o.name, o]));

if (cfg.toolsets) {
  const known = new Set(ALL_OPS.map((o) => o.toolset));
  const bad = [...cfg.toolsets].filter((t) => !known.has(t));
  if (bad.length) console.error(`[clickup-mcp] Unknown toolset(s) ignored: ${bad.join(", ")}. Known: ${[...known].sort().join(", ")}`);
}

/** Input schema as advertised: workspace IDs become optional when a default is configured. */
function advertisedSchema(op: Operation) {
  const s = structuredClone(op.inputSchema);
  if (cfg.defaultWorkspaceId && s.required) {
    s.required = s.required.filter((k) => !isWorkspaceKey(k));
    for (const k of Object.keys(s.properties)) {
      if (isWorkspaceKey(k))
        s.properties[k].description = `${s.properties[k].description || "Workspace ID"} (defaults to ${cfg.defaultWorkspaceId})`;
    }
    if (!s.required.length) delete s.required;
  }
  return s;
}

function toTool(op: Operation): Tool {
  return {
    name: op.name,
    description: op.description,
    inputSchema: advertisedSchema(op) as Tool["inputSchema"],
    annotations: {
      title: op.summary,
      readOnlyHint: op.method === "GET",
      destructiveHint: op.method === "DELETE",
      idempotentHint: ["GET", "PUT", "DELETE"].includes(op.method),
      openWorldHint: true,
    },
  };
}

function buildRawTool(c: Config): Tool {
  return {
    name: "clickup_request",
    description:
      "Send a raw request to any ClickUp API path, for endpoints or parameters the typed tools don't cover. " +
      "Uses the configured token; the host is fixed to the ClickUp API. Example: method=GET, path=/api/v2/team." +
      (c.readOnly ? " Read-only mode: only GET is allowed." : ""),
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: c.readOnly ? ["GET"] : ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string", description: "Path starting with /api/v2/ or /api/v3/ (path params already filled in)." },
        query: {
          type: "object",
          description: "Query parameters. Array values are sent as repeated keys; use 'key[]' as the key for bracket style.",
        },
        body: { description: "JSON request body." },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
    annotations: c.readOnly
      ? { title: "Raw ClickUp request", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      : { title: "Raw ClickUp request", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
}
const RAW_TOOL = buildRawTool(cfg);

/** Server-level guidance sent to the client at initialize time. */
function buildInstructions(c: Config): string {
  const lines = [
    c.mode === "meta"
      ? "Workflow: 1) clickup_search_operations to find an operation, 2) clickup_describe_operation for its schema, " +
        "3) clickup_call_operation with { name, arguments }."
      : "Each ClickUp API operation is its own tool.",
    "Arguments: path and query params go at the top level of `arguments`; the JSON payload goes inside `body`. " +
      "Dates are Unix timestamps in milliseconds.",
  ];
  if (c.defaultWorkspaceId) lines.push(`Default Workspace ID ${c.defaultWorkspaceId} is auto-filled for team_id / workspace_id.`);
  if (c.readOnly) lines.push("Read-only mode: only GET operations are available.");
  if (c.toolsets) lines.push(`Active toolsets: ${[...c.toolsets].sort().join(", ")}.`);
  return lines.join("\n");
}

const META_TOOLS: Tool[] = [
  {
    name: "clickup_search_operations",
    description:
      `Search the ${OPS.length} available ClickUp API operations by keyword (and optional toolset). ` +
      "Returns operation names to use with clickup_describe_operation and clickup_call_operation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. 'create task', 'time entry', 'doc page'. Empty lists all." },
        toolset: { type: "string", description: `Optional toolset filter: ${[...new Set(OPS.map((o) => o.toolset))].sort().join(", ")}` },
        limit: { type: "number", description: "Max results (default 25)." },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Search ClickUp operations",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "clickup_describe_operation",
    description: "Get the full description and JSON input schema for a ClickUp operation before calling it.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Operation name from clickup_search_operations." } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: {
      title: "Describe ClickUp operation",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "clickup_call_operation",
    description: "Call a ClickUp operation by name. `arguments` must match the schema from clickup_describe_operation.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        arguments: { type: "object", description: "Arguments object (path/query params at top level, JSON payload in `body`)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: cfg.readOnly
      ? { title: "Call ClickUp operation", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      : { title: "Call ClickUp operation", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

function listTools(): Tool[] {
  const tools = cfg.mode === "meta" ? [...META_TOOLS] : OPS.map(toTool);
  if (cfg.enableRawRequest) tools.push(RAW_TOOL);
  return tools;
}

function formatResult(r: ApiResult, label: string) {
  let out = r.text;
  try {
    const parsed = JSON.parse(r.text);
    out = renderJson(parsed, cfg.responseFormat);
    if (out.length > cfg.maxResponseChars && cfg.responseFormat === "pretty") out = renderJson(parsed, "json");
  } catch {
    /* not JSON */
  }
  if (!out) out = r.ok ? `(empty response, HTTP ${r.status})` : "";
  if (out.length > cfg.maxResponseChars) {
    out =
      out.slice(0, cfg.maxResponseChars) +
      `\n\n[truncated: response was ${out.length} chars; limit is CLICKUP_MAX_RESPONSE_CHARS=${cfg.maxResponseChars}. Use paging or filters to narrow it.]`;
  }
  if (!r.ok) {
    return { content: [{ type: "text" as const, text: `ClickUp API error (HTTP ${r.status}) from ${label}:\n${out}` }], isError: true };
  }
  return { content: [{ type: "text" as const, text: out }] };
}

const errorResult = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
/** 2 = exact word, 1 = prefix / simple plural ("task" ~ "tasks", "doc" ~ "docs"), 0 = no match. */
const wordHit = (ws: string[], t: string) =>
  ws.some((w) => w === t) ? 2 : ws.some((w) => t.length >= 3 && w.length >= 3 && (w.startsWith(t) || t.startsWith(w))) ? 1 : 0;

/** Everyday verbs mapped to the words ClickUp's operation names use. */
const SYNONYMS: Record<string, string[]> = {
  add: ["create", "add"],
  new: ["create"],
  make: ["create"],
  post: ["create", "send", "post"],
  write: ["create", "send"],
  log: ["create", "track"],
  remove: ["delete", "remove"],
  del: ["delete"],
  edit: ["update", "edit"],
  change: ["update", "edit"],
  modify: ["update", "edit"],
  set: ["set", "update"],
  list: ["get", "list"],
  fetch: ["get"],
  read: ["get"],
  show: ["get"],
  find: ["search", "get", "filtered"],
  timer: ["time", "timer"],
  message: ["message", "chat"],
};

/** Rank operations for a keyword query: name words > summary words > toolset/path > description. */
function searchOps(query = "", toolset?: string, limit = 25) {
  const terms = words(query);
  const exact = terms.join("_");
  const scored = OPS.filter((o) => !toolset || o.toolset === toolset.toLowerCase())
    .map((o) => {
      const nameW = words(o.name);
      const summaryW = words(o.summary);
      const where = `${o.toolset} ${o.path}`.toLowerCase();
      const desc = o.description.toLowerCase();
      const termScore = (t: string) => {
        const n = wordHit(nameW, t);
        if (n) return 4 + n;
        const sm = wordHit(summaryW, t);
        if (sm) return 2 + sm;
        return where.includes(t) ? 2 : desc.includes(t) ? 1 : 0;
      };
      let score = o.name === exact ? 50 : 0;
      for (const t of terms) {
        const direct = termScore(t);
        const viaSynonym = Math.max(0, ...(SYNONYMS[t] || []).filter((x) => x !== t).map((x) => termScore(x) - 1));
        const best = Math.max(direct, viaSynonym);
        score += best || -10;
      }
      return { o, score };
    })
    .filter((x) => !terms.length || x.score > 0)
    .sort((a, b) => b.score - a.score || a.o.name.length - b.o.name.length || a.o.name.localeCompare(b.o.name))
    .slice(0, Math.max(1, Math.min(Number(limit) || 25, 200)));
  return scored.map(({ o }) => ({ name: o.name, toolset: o.toolset, summary: o.summary, http: `${o.method} ${o.path}` }));
}

async function runOperation(op: Operation, args: Record<string, any>) {
  try {
    return formatResult(await client.callOperation(op, args || {}), op.name);
  } catch (e) {
    if (e instanceof UserError) return errorResult(e.message);
    const err = e as Error;
    return errorResult(
      `Request failed for ${op.name}: ${err.name === "TimeoutError" ? `timed out after ${cfg.timeoutMs} ms` : err.message}`,
    );
  }
}

const server = new Server(
  {
    name: PACKAGE_NAME,
    title: "ClickUp (full API)",
    version: VERSION,
    description: "Complete ClickUp API (v2 + v3) MCP server with 4-tool meta mode and full mode.",
    websiteUrl: "https://github.com/KelvinCampelo/clickup-full-mcp#readme",
    icons: [
      {
        src: "https://raw.githubusercontent.com/KelvinCampelo/clickup-full-mcp/main/assets/icon.png",
        mimeType: "image/png",
        sizes: ["512x512"],
      },
      {
        src: "https://raw.githubusercontent.com/KelvinCampelo/clickup-full-mcp/main/assets/icon.svg",
        mimeType: "image/svg+xml",
        sizes: ["any"],
      },
    ],
  },
  { capabilities: { tools: {} }, instructions: buildInstructions(cfg) },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args = (req.params.arguments || {}) as Record<string, any>;

  if (name === RAW_TOOL.name && cfg.enableRawRequest) {
    try {
      return formatResult(await client.rawRequest(args.method, args.path, args.query, args.body), `${args.method} ${args.path}`);
    } catch (e) {
      return errorResult((e as Error).message);
    }
  }

  if (cfg.mode === "meta") {
    if (name === "clickup_search_operations") {
      const res = searchOps(args.query, args.toolset, args.limit ?? 25);
      return { content: [{ type: "text", text: res.length ? renderMeta(res, cfg.responseFormat) : "No matching operations." }] };
    }
    if (name === "clickup_describe_operation") {
      const op = OPS_BY_NAME.get(args.name);
      if (!op) return errorResult(`Unknown operation "${args.name}". Use clickup_search_operations.`);
      const t = toTool(op);
      return {
        content: [
          {
            type: "text",
            text: renderMeta(
              { name: t.name, description: t.description, http: `${op.method} ${op.path}`, inputSchema: t.inputSchema },
              cfg.responseFormat,
            ),
          },
        ],
      };
    }
    if (name === "clickup_call_operation") {
      const op = OPS_BY_NAME.get(args.name);
      if (!op) return errorResult(`Unknown operation "${args.name}". Use clickup_search_operations.`);
      return runOperation(op, args.arguments || {});
    }
    return errorResult(`Unknown tool "${name}"`);
  }

  const op = OPS_BY_NAME.get(name);
  if (!op) return errorResult(`Unknown or disabled tool "${name}"`);
  return runOperation(op, args);
});

await server.connect(new StdioServerTransport());

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close().finally(() => process.exit(0));
  });
}
console.error(
  `[clickup-mcp] v${VERSION} ready: ${cfg.mode} mode, ${OPS.length}/${ALL_OPS.length} operations` +
    `${cfg.readOnly ? " (read-only)" : ""}${cfg.token ? "" : " — WARNING: CLICKUP_API_TOKEN not set"}`,
);
