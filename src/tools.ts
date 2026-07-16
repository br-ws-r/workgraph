/**
 * Unified tool registrations for pi-cognee.
 *
 * All tools delegate to the active backend (SDK or MCP), so the LLM
 * sees the same interface regardless of which mode is in use.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CogneeBackend } from "./types.js";

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

/** Register all Cognee tools on the given pi extension API. */
export function registerTools(pi: ExtensionAPI, backend: CogneeBackend): void {
  // ---- health ----
  pi.registerTool({
    name: "cognee_health",
    label: "Cognee Health",
    description:
      "Check connectivity to Cognee. In SDK mode verifies the in-process engine; in MCP mode pings the MCP server.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return backend.health();
    },
  });

  // ---- remember ----
  pi.registerTool({
    name: "cognee_remember",
    label: "Remember (Store Memory)",
    description:
      "Store data in Cognee memory. With session_id: fast session cache. Without: permanent graph memory (runs full add + cognify pipeline).",
    parameters: Type.Object({
      data: Type.String({ description: "Text content to store." }),
      dataset_name: Type.Optional(
        Type.String({
          description:
            "Target dataset name. Defaults to the agent-scoped dataset.",
        }),
      ),
      session_id: Type.Optional(
        Type.String({
          description:
            "Session ID. When set, stores in session cache only (fast, no entity extraction).",
        }),
      ),
      custom_prompt: Type.Optional(
        Type.String({
          description:
            "Custom prompt for entity extraction (permanent mode only).",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      return backend.remember(params);
    },
  });

  // ---- recall ----
  pi.registerTool({
    name: "cognee_recall",
    label: "Recall Memory",
    description:
      "Search Cognee memory. Auto-routing picks the best search strategy when search_type is omitted.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language query." }),
      search_type: Type.Optional(
        Type.String({
          description:
            "Override auto-routing: GRAPH_COMPLETION, RAG_COMPLETION, CHUNKS, SUMMARIES, TEMPORAL, FEELING_LUCKY, etc.",
        }),
      ),
      datasets: Type.Optional(
        Type.String({
          description: "Comma-separated dataset names to search within.",
        }),
      ),
      session_id: Type.Optional(
        Type.String({
          description: "Session ID for session-first search.",
        }),
      ),
      top_k: Type.Optional(
        Type.Number({ default: 10, description: "Max results (default 10)." }),
      ),
    }),
    async execute(_id, params, signal) {
      return backend.recall(params);
    },
  });

  // ---- forget ----
  pi.registerTool({
    name: "cognee_forget",
    label: "Forget (Delete Memory)",
    description:
      "Delete data from Cognee memory. Can target a specific dataset or delete everything the user owns.",
    parameters: Type.Object({
      dataset: Type.Optional(
        Type.String({ description: "Dataset name to delete entirely." }),
      ),
      everything: Type.Optional(
        Type.Boolean({
          default: false,
          description:
            "If true, delete ALL data across all datasets the user owns.",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      return backend.forget(params);
    },
  });

  // ---- datasets ----
  pi.registerTool({
    name: "cognee_datasets",
    label: "List Cognee Datasets",
    description:
      "List datasets as structured JSON. Returns {datasets: [{id, name}, ...]}.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return backend.datasets();
    },
  });

  // ---- dataset_data ----
  pi.registerTool({
    name: "cognee_dataset_data",
    label: "List Dataset Data",
    description:
      "List data items in a dataset as structured JSON. Returns {data: [{id, name}, ...]}.",
    parameters: Type.Object({
      dataset_id: Type.String({ description: "Dataset ID to list data for." }),
    }),
    async execute(_id, params, signal) {
      return backend.datasetData(params);
    },
  });

  // ---- create_dataset ----
  pi.registerTool({
    name: "cognee_create_dataset",
    label: "Create Dataset",
    description:
      "Create an empty dataset with the given name (idempotent). Returns {dataset: {id, name}}.",
    parameters: Type.Object({
      name: Type.String({ description: "Name for the new dataset." }),
    }),
    async execute(_id, params, signal) {
      return backend.createDataset(params);
    },
  });

  // ---- client_info ----
  pi.registerTool({
    name: "cognee_client_info",
    label: "Cognee Client Info",
    description:
      "Return the current client identity, mode, and default dataset.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return backend.clientInfo();
    },
  });

  // ---- cognify_file ----
  pi.registerTool({
    name: "cognee_cognify_file",
    label: "Cognify File",
    description:
      "Ingest a file into Cognee memory. Accepts the file as base64. Runs add synchronously, then launches cognify in the background.",
    parameters: Type.Object({
      filename: Type.String({
        description: "Original filename (e.g. report.pdf).",
      }),
      content_base64: Type.String({
        description: "Base64-encoded file content.",
      }),
      dataset_name: Type.Optional(
        Type.String({
          description: "Target dataset name.",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      return backend.cognifyFile(params);
    },
  });
}
