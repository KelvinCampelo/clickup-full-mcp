import { readFileSync } from "node:fs";

/** Package name and version, read from package.json so they never drift from the published release. */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };

export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;
