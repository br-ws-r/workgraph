/**
 * pi-cognee — Cognee AI memory for Pi coding agent.
 *
 * Supports two backends:
 *   • SDK  — in-process via @cognee/cognee-ts (no separate server needed)
 *   • MCP  — remote Cognee MCP server over Streamable HTTP
 *
 * Commands:
 *   /cognee-mode [sdk|mcp]  — switch between SDK and MCP backends
 *   /cognee-config [key] [value] — get/set config values
 *
 * Tools (available in both modes):
 *   cognee_health, cognee_remember, cognee_recall, cognee_forget,
 *   cognee_datasets, cognee_dataset_data, cognee_create_dataset,
 *   cognee_client_info, cognee_cognify_file
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig, writeConfig, getMode } from "./src/config.js";
import { sdkBackend, resetInstance } from "./src/sdk/client.js";
import { mcpBackend, clearMcpCache } from "./src/mcp/client.js";
import { registerTools } from "./src/tools.js";
import type { CogneeBackend, CogneeMode } from "./src/types.js";

export default function (pi: ExtensionAPI) {
  // Resolve the active backend based on current config.
  function getBackend(): CogneeBackend {
    return getMode() === "mcp" ? mcpBackend : sdkBackend;
  }

  // Register all tools with the active backend.
  registerTools(pi, getBackend());

  // ---- /cognee-mode — switch between SDK and MCP ------------------------
  pi.registerCommand("cognee-mode", {
    description:
      "Switch the Cognee backend mode.  /cognee-mode sdk  or  /cognee-mode mcp",
    handler: async (args, ctx) => {
      const mode = (args ?? "").trim().toLowerCase();
      if (mode !== "sdk" && mode !== "mcp") {
        ctx.ui.notify(
          `Current mode: ${getMode()}.  Usage: /cognee-mode sdk  or  /cognee-mode mcp`,
          "info",
        );
        return;
      }

      writeConfig({ mode: mode as CogneeMode });

      // Clear cached state for the old backend.
      if (mode === "sdk") {
        clearMcpCache();
      } else {
        resetInstance();
      }

      ctx.ui.notify(
        `Cognee mode → ${mode.toUpperCase()}.  Use /reload to re-register tools with the new backend.`,
        "info",
      );
    },
  });

  // ---- /cognee-config — get/set config values ---------------------------
  pi.registerCommand("cognee-config", {
    description:
      "Get or set Cognee config.  /cognee-config  (show all)  /cognee-config llmModel gpt-4o  (set a value)",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const cfg = readConfig();

      if (!parts[0]) {
        // Show current config (redact API keys).
        const display = { ...cfg };
        if (display.llmApiKey) display.llmApiKey = "***";
        ctx.ui.notify(JSON.stringify(display, null, 2), "info");
        return;
      }

      if (parts.length === 1) {
        // Show one key.
        const key = parts[0];
        if (key in cfg) {
          const val = (cfg as unknown as Record<string, unknown>)[key];
          const display = key === "llmApiKey" && typeof val === "string" ? "***" : val;
          ctx.ui.notify(`${key} = ${JSON.stringify(display)}`, "info");
        } else {
          ctx.ui.notify(`Unknown config key: ${key}`, "error");
        }
        return;
      }

      // Set a value.
      const key = parts[0];
      const value = parts.slice(1).join(" ");
      const validKeys = [
        "mode", "mcpUrl", "llmModel", "llmApiKey",
        "embeddingProvider", "embeddingModel",
        "vectorDbProvider", "graphDbProvider",
      ];

      if (!validKeys.includes(key)) {
        ctx.ui.notify(
          `Unknown config key: ${key}.  Valid keys: ${validKeys.join(", ")}`,
          "error",
        );
        return;
      }

      writeConfig({ [key]: value });
      resetInstance();
      clearMcpCache();

      ctx.ui.notify(`${key} → ${key === "llmApiKey" ? "***" : value}`, "info");
    },
  });
}
