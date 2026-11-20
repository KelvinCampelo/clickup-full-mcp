export type ResponseFormat = "compact" | "json" | "pretty";

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/**
 * Recursively drop object keys whose value is null, "", [] or {} (after pruning their children).
 * Array elements are never removed, so positions stay meaningful. false and 0 are kept.
 */
export function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item !== null && typeof item === "object" ? pruneEmpty(item) : item));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const pruned = v !== null && typeof v === "object" ? pruneEmpty(v) : v;
    if (!isEmpty(pruned)) out[k] = pruned;
  }
  return out;
}

/** Serialize an API response body for the model. */
export function renderJson(value: unknown, format: ResponseFormat): string {
  if (format === "pretty") return JSON.stringify(value, null, 2);
  if (format === "json") return JSON.stringify(value);
  return JSON.stringify(pruneEmpty(value));
}

/** Serialize server-generated data (search results, schemas): never pruned, indented only in pretty mode. */
export const renderMeta = (value: unknown, format: ResponseFormat) =>
  format === "pretty" ? JSON.stringify(value, null, 2) : JSON.stringify(value);
