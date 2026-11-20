import fs from "node:fs";
import path from "node:path";
import type { ResponseFormat } from "./format.js";

export interface Config {
  token: string | undefined;
  baseUrl: string;
  mode: "full" | "meta";
  toolsets: Set<string> | null;
  readOnly: boolean;
  disabledTools: Set<string>;
  defaultWorkspaceId: string | undefined;
  maxResponseChars: number;
  responseFormat: ResponseFormat;
  timeoutMs: number;
  maxRetries: number;
  uploadRoots: string[] | null;
  enableRawRequest: boolean;
}

export class ConfigError extends Error {}

const list = (v: string | undefined) =>
  (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v));

function num(name: string, v: string | undefined, dflt: number, min: number): number {
  if (v === undefined || v.trim() === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new ConfigError(`${name} must be a number >= ${min} (got "${v}")`);
  return n;
}

/**
 * Resolve symlinks so that containment checks compare real locations. Uses the native implementation,
 * the same one fs.promises.realpath uses for uploaded files (it also expands Windows 8.3 short names).
 */
function realpathOrResolve(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

export function loadConfig(env = process.env): Config {
  const mode = (env.CLICKUP_TOOL_MODE || "meta").toLowerCase();
  if (mode !== "full" && mode !== "meta") throw new ConfigError(`CLICKUP_TOOL_MODE must be "full" or "meta" (got "${mode}")`);
  const toolsets = list(env.CLICKUP_TOOLSETS).map((s) => s.toLowerCase());
  const roots = list(env.CLICKUP_UPLOAD_ROOTS).map(realpathOrResolve);
  const responseFormat = (env.CLICKUP_RESPONSE_FORMAT || "compact").toLowerCase();
  if (responseFormat !== "compact" && responseFormat !== "json" && responseFormat !== "pretty") {
    throw new ConfigError(`CLICKUP_RESPONSE_FORMAT must be "compact", "json" or "pretty" (got "${responseFormat}")`);
  }
  const baseUrl = (env.CLICKUP_BASE_URL || "https://api.clickup.com").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/i.test(baseUrl)) throw new ConfigError(`CLICKUP_BASE_URL must be an http(s) URL (got "${baseUrl}")`);
  return {
    token: env.CLICKUP_API_TOKEN || env.CLICKUP_TOKEN || undefined,
    baseUrl,
    mode,
    toolsets: toolsets.length && !toolsets.includes("all") ? new Set(toolsets) : null,
    readOnly: bool(env.CLICKUP_READ_ONLY, false),
    disabledTools: new Set(list(env.CLICKUP_DISABLED_TOOLS)),
    defaultWorkspaceId: env.CLICKUP_WORKSPACE_ID || env.CLICKUP_TEAM_ID || undefined,
    responseFormat,
    maxResponseChars: num("CLICKUP_MAX_RESPONSE_CHARS", env.CLICKUP_MAX_RESPONSE_CHARS, 100_000, 1),
    timeoutMs: num("CLICKUP_TIMEOUT_MS", env.CLICKUP_TIMEOUT_MS, 60_000, 1),
    maxRetries: num("CLICKUP_MAX_RETRIES", env.CLICKUP_MAX_RETRIES, 3, 0),
    uploadRoots: roots.length ? roots : null,
    enableRawRequest: bool(env.CLICKUP_ENABLE_RAW_REQUEST, true),
  };
}
