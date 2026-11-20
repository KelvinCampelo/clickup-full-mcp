#!/usr/bin/env node
// Downloads the latest official ClickUp OpenAPI specs into ./spec (run `npm run update-spec`).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  "clickup-api-v2-reference.json": "https://developer.clickup.com/openapi/clickup-api-v2-reference.json",
  "ClickUp_PUBLIC_API_V3.yaml": "https://developer.clickup.com/openapi/ClickUp_PUBLIC_API_V3.yaml",
};
for (const [name, url] of Object.entries(files)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(path.join(root, "spec", name), text);
  console.log(`Updated spec/${name} (${(text.length / 1024).toFixed(0)} KB)`);
}
