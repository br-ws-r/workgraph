/**
 * Configuration management for pi-cognee.
 *
 * Reads/writes ~/.pi/agent/cognee-config.json.  Defaults to SDK mode
 * so the package works out of the box with @cognee/cognee-ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CogneeConfig, CogneeMode } from "./types.js";

const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".pi",
  "agent",
);
const CONFIG_PATH = path.join(CONFIG_DIR, "cognee-config.json");

const DEFAULTS: CogneeConfig = {
  mode: "sdk",
  mcpUrl: "http://localhost:8001/mcp",
};

/** Read the current config, merging with defaults. */
export function readConfig(): CogneeConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Write a partial update to the config file. */
export function writeConfig(update: Partial<CogneeConfig>): void {
  const current = readConfig();
  const merged = { ...current, ...update };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
}

/** Get the current operating mode. */
export function getMode(): CogneeMode {
  return readConfig().mode;
}

/** Get the MCP URL (with fallback). */
export function getMcpUrl(): string {
  return readConfig().mcpUrl || DEFAULTS.mcpUrl!;
}
