#!/usr/bin/env node
/**
 * Generates src/generated/operations.json from ClickUp's official OpenAPI specs
 * (spec/clickup-api-v2-reference.json and spec/ClickUp_PUBLIC_API_V3.yaml).
 *
 * Each OpenAPI operation becomes one MCP tool definition:
 *   - path + query params  -> top-level tool arguments
 *   - JSON request body    -> `body` argument (full JSON schema, $refs resolved)
 *   - multipart uploads    -> `file_path` / `file_base64` + `file_name` arguments
 *
 * It also patches a few places where the spec does not match how the live API
 * behaves (array query encoding, upload field names, OAuth token exchange).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import $RefParser from "@apidevtools/json-schema-ref-parser";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPECS = [
  { version: "v2", file: "spec/clickup-api-v2-reference.json" },
  { version: "v3", file: "spec/ClickUp_PUBLIC_API_V3.yaml" },
];
const METHODS = ["get", "post", "put", "patch", "delete"];

// Friendlier tool names where the spec summary is awkward or ambiguous.
const NAME_OVERRIDES = {
  "GetTask'sTimeinStatus": "get_task_time_in_status",
  "GetBulkTasks'TimeinStatus": "get_bulk_tasks_time_in_status",
  GetTeamViews: "get_workspace_views",
  CreateTeamView: "create_workspace_view",
  queryAuditLog: "query_audit_logs",
  publicPatchAcl: "update_privacy_and_access",
  getSubtypes: "get_post_subtype_ids",
  createLocationChatChannel: "create_location_chat_channel",
  createDirectMessageChatChannel: "create_direct_message_channel",
  getChatChannels: "get_chat_channels",
  createChatChannel: "create_chat_channel",
  getChatChannel: "get_chat_channel",
  updateChatChannel: "update_chat_channel",
  deleteChatChannel: "delete_chat_channel",
  getChatChannelFollowers: "get_chat_channel_followers",
  getChatChannelMembers: "get_chat_channel_members",
  getChatMessages: "get_chat_messages",
  createChatMessage: "send_chat_message",
  patchChatMessage: "update_chat_message",
  deleteChatMessage: "delete_chat_message",
  getChatMessageReactions: "get_chat_message_reactions",
  createChatReaction: "create_chat_reaction",
  deleteChatReaction: "delete_chat_reaction",
  getChatMessageReplies: "get_chat_message_replies",
  createReplyMessage: "create_chat_reply",
  getChatMessageTaggedUsers: "get_chat_message_tagged_users",
  getParentEntityAttachments: "get_attachments",
  postEntityAttachment: "create_attachment",
  getPagePublic: "get_doc_page",
  getDocPagesPublic: "get_doc_pages",
  getDocPageListingPublic: "get_doc_page_listing",
  createPagePublic: "create_doc_page",
  editPagePublic: "edit_doc_page",
  getDocPublic: "get_doc",
  createDocPublic: "create_doc",
  searchDocsPublic: "search_docs",
  moveTask: "move_task",
  replaceTimeEstimatesByUser: "replace_task_time_estimates",
  updateTimeEstimatesByUser: "update_task_time_estimates",
  Getsingulartimeentry: "get_time_entry",
  Getalltagsfromtimeentries: "get_time_entry_tags",
  Addtagsfromtimeentries: "add_tags_to_time_entries",
  Changetagnamesfromtimeentries: "change_time_entry_tag_names",
  Removetagsfromtimeentries: "remove_tags_from_time_entries",
  Gettrackedtime: "get_tracked_time_legacy",
  Tracktime: "track_time_legacy",
  Edittimetracked: "edit_time_tracked_legacy",
  Deletetimetracked: "delete_time_tracked_legacy",
  GetAccessibleCustomFields: "get_list_custom_fields",
  GetCustomItems: "get_custom_task_types",
  GetAuthorizedTeams: "get_authorized_workspaces",
  CreateUserGroup: "create_user_group",
  UpdateTeam: "update_user_group",
  DeleteTeam: "delete_user_group",
  GetTeams1: "get_user_groups",
};

// Array query parameters whose value is a JSON document, not a list of scalars.
const JSON_QUERY_PARAMS = new Set(["custom_fields", "custom_field"]);
// Upload field name expected by the live API, per operation.
const UPLOAD_FIELD = { CreateTaskAttachment: "attachment", postEntityAttachment: "file" };

const toolsetOf = (tags = []) => {
  const t = (tags.find((x) => !/^(acls|auditlogs)$/i.test(x)) || tags[0] || "misc").replace(/\(.*?\)/g, "").trim();
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
};

const snake = (s) =>
  s
    .replace(/['’]/g, "")
    .replace(/\(.*?\)/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !["a", "an", "the"].includes(w))
    .join("_")
    .slice(0, 64);

const cleanText = (s = "", max = 1500) => {
  let t = String(s)
    .replace(/\\\s*\n/g, "\n") // readme.io line-continuation backslashes
    .replace(/^\s*\\\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\(ref:([A-Za-z0-9_']+)\)/g, "(see $1)")
    .trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
};

const STD_FORMATS = new Set(["date-time", "date", "time", "email", "uri", "uuid"]);
const DROP_KEYS = new Set([
  "example",
  "examples",
  "xml",
  "externalDocs",
  "x-readme",
  "discriminator",
  "contentMediaType",
  "contentEncoding",
]);

/** Make an OpenAPI schema fragment a compact, plain JSON Schema. */
function cleanSchema(schema, depth = 0, seen = new WeakSet()) {
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((s) => cleanSchema(s, depth + 1, seen));
  if (seen.has(schema) || depth > 40) return {}; // circular or absurdly deep -> accept anything
  seen.add(schema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (DROP_KEYS.has(k) || k.startsWith("x-")) continue;
    if (k === "$ref") continue; // unresolved (circular) ref -> drop
    if (k === "description" || k === "title") {
      if (k === "title") continue;
      out.description = cleanText(v, 400);
      continue;
    }
    if (k === "nullable") continue;
    if (k === "format" && !STD_FORMATS.has(v)) continue; // e.g. RichText, int64 — not JSON Schema formats
    if (k === "readOnly" && v) continue;
    if (k === "properties" && v && typeof v === "object") {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) {
        if (pv && pv.readOnly) continue;
        out.properties[pk] = cleanSchema(pv, depth + 1, seen);
      }
      continue;
    }
    out[k] = typeof v === "object" ? cleanSchema(v, depth + 1, seen) : v;
  }
  if (schema.nullable === true && typeof out.type === "string") out.type = [out.type, "null"];
  if (Array.isArray(out.required) && out.properties) {
    out.required = out.required.filter((r) => r in out.properties);
    if (!out.required.length) delete out.required;
  }
  if (out.type === "array" && !out.items) out.items = {};
  seen.delete(schema);
  return out;
}

const argKey = (name) =>
  name
    .replace(/\[\]$/, "")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 64);

function queryStyle(op, p, schema) {
  if (schema?.type !== "array") return "plain";
  const bare = p.name.replace(/\[\]$/, "");
  if (JSON_QUERY_PARAMS.has(bare)) return "json";
  if (p.name.endsWith("[]")) return "brackets";
  // GetTasks documents every list filter as name[]=a&name[]=b
  if (op.operationId === "GetTasks" || (p.description || "").includes(`${bare}[]=`)) return "brackets";
  return "repeat"; // name=a&name=b (e.g. group_ids)
}

async function main() {
  const operations = [];
  const names = new Map();
  for (const { version, file } of SPECS) {
    const rawText = fs.readFileSync(path.join(root, file), "utf8");
    const raw = file.endsWith(".json") ? JSON.parse(rawText) : YAML.parse(rawText);
    const spec = await $RefParser.dereference(raw, { dereference: { circular: "ignore" } });
    const serverPath = new URL(spec.servers?.[0]?.url || "https://api.clickup.com").pathname.replace(/\/$/, "");

    for (const [p, item] of Object.entries(spec.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        const opId = op.operationId;
        let name = NAME_OVERRIDES[opId] || snake(op.summary || opId);
        if (names.has(name)) name = `${name}_${version}`;
        if (names.has(name)) throw new Error(`Duplicate tool name ${name}`);
        names.set(name, opId);

        // Merge path-level and operation-level parameters.
        const params = new Map();
        for (const prm of [...(item.parameters || []), ...(op.parameters || [])]) params.set(`${prm.in}:${prm.name}`, prm);

        const properties = {};
        const required = [];
        const paramMap = [];
        for (const prm of params.values()) {
          if (prm.in === "header" || prm.in === "cookie") continue; // only Content-Type headers exist; set automatically
          let key = argKey(prm.name);
          // Same name in path and query (e.g. team_id on UpdateatimeEntry): prefix the query one.
          if (properties[key] && prm.in === "query") key = `query_${key}`;
          const schema = cleanSchema(prm.schema || { type: "string" });
          const style = prm.in === "query" ? queryStyle(op, prm, schema) : "plain";
          let propSchema = { ...schema };
          if (style === "json") {
            propSchema = {
              description: "JSON value (array/object) or a pre-encoded JSON string.",
              anyOf: [{ type: "array", items: {} }, { type: "object" }, { type: "string" }],
            };
          }
          const desc = cleanText(prm.description || schema.description || "", 600);
          if (desc) propSchema.description = desc;
          if (properties[key]) throw new Error(`Arg collision ${name}.${key}`);
          properties[key] = propSchema;
          if (prm.required || prm.in === "path") required.push(key);
          paramMap.push({ key, name: prm.name, in: prm.in, style });
        }

        // Request body
        let body = null;
        const content = op.requestBody?.content || {};
        const cts = Object.keys(content);
        if (cts.includes("multipart/form-data")) {
          const ms = cleanSchema(content["multipart/form-data"].schema || {});
          const extra = {};
          for (const [k, v] of Object.entries(ms.properties || {})) if (!(v.type === "array" && k === "attachment")) extra[k] = v;
          properties.file_path = {
            type: "string",
            description: "Absolute path of a local file to upload (read by this MCP server on your machine).",
          };
          properties.file_base64 = { type: "string", description: "Alternative to file_path: base64-encoded file content." };
          properties.file_name = { type: "string", description: "File name to send (defaults to the basename of file_path)." };
          properties.form_fields = {
            type: "object",
            description:
              "Extra multipart form fields." + (Object.keys(extra).length ? ` Known fields: ${Object.keys(extra).join(", ")}.` : ""),
            properties: extra,
          };
          body = { type: "multipart", fileField: UPLOAD_FIELD[opId] || "file" };
        } else if (cts.length) {
          const ct = cts.includes("application/json") ? "application/json" : cts[0];
          const bs = cleanSchema(content[ct].schema || { type: "object" });
          bs.description = cleanText(op.requestBody.description || bs.description || "Request body (JSON).", 600);
          properties.body = bs;
          if (op.requestBody.required) required.push("body");
          body = { type: "json" };
        }

        const fullPath = `${serverPath}${p}`.replace(/\/{2,}/g, "/");
        const toolset = toolsetOf(op.tags);
        const descParts = [
          op.summary,
          cleanText(op.description, 1200),
          op.deprecated ? "DEPRECATED in ClickUp's API." : "",
          `ClickUp API ${version}: ${method.toUpperCase()} ${fullPath}`,
        ].filter(Boolean);

        operations.push({
          name,
          operationId: opId,
          version,
          toolset,
          method: method.toUpperCase(),
          path: fullPath,
          summary: op.summary || opId,
          description: [...new Set(descParts)].join("\n\n"),
          auth: opId !== "GetAccessToken",
          params: paramMap,
          body,
          inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
        });
      }
    }
  }

  operations.sort((a, b) => a.toolset.localeCompare(b.toolset) || a.name.localeCompare(b.name));
  const outFile = path.join(root, "src/generated/operations.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(operations));

  const bySet = {};
  for (const o of operations) bySet[o.toolset] = (bySet[o.toolset] || 0) + 1;
  console.log(`Generated ${operations.length} operations (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`);
  console.log(bySet);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
