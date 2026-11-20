import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { PACKAGE_NAME, VERSION } from "./version.js";

export interface ParamDef {
  key: string;
  name: string;
  in: "path" | "query";
  style: "plain" | "brackets" | "repeat" | "json";
}

export interface Operation {
  name: string;
  operationId: string;
  version: "v2" | "v3";
  toolset: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  description: string;
  auth: boolean;
  params: ParamDef[];
  body: null | { type: "json" } | { type: "multipart"; fileField: string };
  inputSchema: { type: "object"; properties: Record<string, any>; required?: string[]; additionalProperties?: boolean };
}

export interface ApiResult {
  ok: boolean;
  status: number;
  text: string;
}

export class UserError extends Error {}

const WORKSPACE_KEYS = new Set(["team_id", "team_Id", "workspace_id", "workspaceId"]);
export const isWorkspaceKey = (k: string) => WORKSPACE_KEYS.has(k);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function authHeader(token: string) {
  // Personal tokens (pk_...) are sent as-is; OAuth access tokens need "Bearer".
  if (/^(pk_|bearer\s)/i.test(token)) return token;
  return `Bearer ${token}`;
}

/** True when `child` is `parent` or lies inside it (both must be absolute, normalized paths). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export class ClickUpClient {
  constructor(private cfg: Config) {}

  /** Build and execute the HTTP request for a generated operation. */
  async callOperation(op: Operation, rawArgs: Record<string, any>): Promise<ApiResult> {
    const args = { ...(rawArgs || {}) };

    // Fill the Workspace ID from config when the caller omitted it.
    if (this.cfg.defaultWorkspaceId) {
      for (const p of op.params) {
        if (isWorkspaceKey(p.key) && (args[p.key] === undefined || args[p.key] === "")) {
          if (p.in === "path" || op.inputSchema.required?.includes(p.key)) args[p.key] = this.cfg.defaultWorkspaceId;
        }
      }
    }

    const known = new Set(Object.keys(op.inputSchema.properties));
    const unknown = Object.keys(args).filter((k) => !known.has(k));
    if (unknown.length) {
      throw new UserError(
        `Unknown argument(s) for ${op.name}: ${unknown.join(", ")}. Valid arguments: ${[...known].join(", ")}` +
          (known.has("body") ? ". Request-body fields go inside `body`." : ""),
      );
    }

    const missing = (op.inputSchema.required || []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
    if (op.body?.type === "multipart" && !args.file_path && !args.file_base64) missing.push("file_path (or file_base64)");
    if (missing.length) throw new UserError(`Missing required argument(s) for ${op.name}: ${missing.join(", ")}`);

    let urlPath = op.path;
    const query = new URLSearchParams();
    for (const p of op.params) {
      const v = args[p.key];
      if (v === undefined || v === null) continue;
      if (p.in === "path") {
        urlPath = urlPath.replace(`{${p.name}}`, encodeURIComponent(scalar(v)));
        continue;
      }
      switch (p.style) {
        case "json":
          query.append(p.name, typeof v === "string" ? v : JSON.stringify(v));
          break;
        case "brackets": {
          const n = p.name.endsWith("[]") ? p.name : `${p.name}[]`;
          for (const item of Array.isArray(v) ? v : [v]) query.append(n, scalar(item));
          break;
        }
        case "repeat":
          for (const item of Array.isArray(v) ? v : [v]) query.append(p.name, scalar(item));
          break;
        default:
          query.append(p.name, scalar(v));
      }
    }
    if (/\{[^}]+\}/.test(urlPath)) throw new UserError(`Unresolved path parameter in ${urlPath}`);

    let body: BodyInit | undefined;
    const headers: Record<string, string> = {};
    if (op.body?.type === "json" && args.body !== undefined) {
      body = JSON.stringify(args.body);
      headers["Content-Type"] = "application/json";
    } else if (op.body?.type === "multipart") {
      body = await this.buildMultipart(op.body.fileField, args);
    }

    return this.request(op.method, urlPath, query, body, headers, op.auth);
  }

  /** Arbitrary call to a ClickUp API path (escape hatch for endpoints the spec gets wrong). */
  async rawRequest(method: string, apiPath: string, query?: Record<string, any>, body?: unknown): Promise<ApiResult> {
    const m = String(method ?? "").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(m)) throw new UserError(`Unsupported method ${method}`);
    let p = String(apiPath ?? "").trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("//")) throw new UserError("Pass a path such as /api/v2/team, not a full URL.");
    if (!p.startsWith("/")) p = "/" + p;
    if (/^\/v[23]\//.test(p)) p = "/api" + p;
    // Normalize the way fetch() will (resolves "..", "%2e%2e", "\"), then re-check the prefix.
    const PROBE = "https://clickup-mcp.invalid";
    const parsed = new URL(p, PROBE);
    if (parsed.origin !== PROBE || parsed.hash) throw new UserError("Path must not change the host or contain a #fragment.");
    if (!/^\/api\/v[23]\//.test(p) || !/^\/api\/v[23]\//.test(parsed.pathname))
      throw new UserError("Path must start with /api/v2/ or /api/v3/.");
    if (this.cfg.readOnly && m !== "GET") throw new UserError("Server is in read-only mode (CLICKUP_READ_ONLY); only GET is allowed.");
    p = parsed.pathname;
    const qs = new URLSearchParams(parsed.search);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null) continue;
      for (const item of Array.isArray(v) ? v : [v]) qs.append(k, scalar(item));
    }
    const headers: Record<string, string> = {};
    let b: string | undefined;
    if (body !== undefined && m !== "GET") {
      b = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    return this.request(m, p, qs, b, headers, true);
  }

  private async buildMultipart(fileField: string, args: Record<string, any>): Promise<FormData> {
    let data: Buffer;
    let fileName = args.file_name as string | undefined;
    if (args.file_path) {
      const abs = path.resolve(String(args.file_path));
      let real: string;
      try {
        real = await fs.realpath(abs); // follow symlinks so they can't escape CLICKUP_UPLOAD_ROOTS
      } catch {
        throw new UserError(`file_path not found or not readable: ${abs}`);
      }
      if (this.cfg.uploadRoots && !this.cfg.uploadRoots.some((r) => isInside(real, r))) {
        throw new UserError(`file_path is outside the allowed upload folders (CLICKUP_UPLOAD_ROOTS): ${abs}`);
      }
      data = await fs.readFile(real);
      fileName ||= path.basename(abs);
    } else {
      data = Buffer.from(String(args.file_base64), "base64");
      fileName ||= "upload.bin";
    }
    const form = new FormData();
    for (const [k, v] of Object.entries(args.form_fields || {})) form.append(k, scalar(v));
    form.append(fileField, new Blob([new Uint8Array(data)]), fileName);
    return form;
  }

  private async request(
    method: string,
    urlPath: string,
    query: URLSearchParams,
    body: BodyInit | undefined,
    headers: Record<string, string>,
    needsAuth: boolean,
  ): Promise<ApiResult> {
    if (needsAuth) {
      if (!this.cfg.token)
        throw new UserError("CLICKUP_API_TOKEN is not set. Add a personal token (pk_...) or OAuth access token to the MCP server's env.");
      headers["Authorization"] = authHeader(this.cfg.token);
    }
    headers["Accept"] = "application/json";
    headers["User-Agent"] = `${PACKAGE_NAME}/${VERSION}`;
    const qs = query.toString();
    const url = `${this.cfg.baseUrl}${urlPath}${qs ? `?${qs}` : ""}`;

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
      if (res.status === 429 && attempt < this.cfg.maxRetries) {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const retryAfter = Number(res.headers.get("retry-after"));
        let wait = retryAfter > 0 ? retryAfter * 1000 : reset > 0 ? reset * 1000 - Date.now() : 2000 * 2 ** attempt;
        wait = Math.min(Math.max(wait, 500), 60_000);
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    }
  }
}
