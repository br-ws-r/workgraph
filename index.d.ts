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
export default function (pi: ExtensionAPI): void;
