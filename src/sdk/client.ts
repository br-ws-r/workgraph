/**
 * Direct SDK backend using @cognee/cognee-ts.
 *
 * No separate MCP server required — Cognee runs in-process via Neon bindings.
 * Requires LLM + embedding API keys configured via config or env vars.
 */

import { init, Cognee } from "@cognee/cognee-ts";
import type {
  CogneeBackend,
  CogneeResult,
  RememberParams,
  RecallParams,
  ForgetParams,
  DatasetDataParams,
  CreateDatasetParams,
  CognifyFileParams,
} from "../types.js";
import { readConfig } from "../config.js";

// One-time Neon runtime bootstrap (idempotent, safe to call multiple times).
let _initialized = false;

function ensureInit(): void {
  if (!_initialized) {
    init();
    _initialized = true;
  }
}

/** Lazy singleton — created on first use, rebuilt if config changes. */
let _instance: Cognee | null = null;
let _instanceConfigHash = "";

function configHash(cfg: Record<string, unknown>): string {
  return JSON.stringify(cfg);
}

async function getCognee(): Promise<Cognee> {
  ensureInit();
  const cfg = readConfig();
  const hash = configHash(cfg as unknown as Record<string, unknown>);

  if (_instance && _instanceConfigHash === hash) return _instance;

  const settings: Record<string, string> = {};
  if (cfg.llmModel) settings.llmModel = cfg.llmModel;
  if (cfg.llmApiKey) settings.llmApiKey = cfg.llmApiKey;
  if (cfg.embeddingProvider) settings.embeddingProvider = cfg.embeddingProvider;
  if (cfg.embeddingModel) settings.embeddingModel = cfg.embeddingModel;
  if (cfg.vectorDbProvider) settings.vectorDbProvider = cfg.vectorDbProvider;
  if (cfg.graphDbProvider) settings.graphDbProvider = cfg.graphDbProvider;

  _instance = new Cognee(Object.keys(settings).length > 0 ? settings : undefined);
  _instanceConfigHash = hash;

  // Warm up engines (builds embedding model, resolves default user).
  await _instance.warm();

  return _instance;
}

/** Reset the cached instance (used after config changes). */
export function resetInstance(): void {
  _instance = null;
  _instanceConfigHash = "";
}

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

export const sdkBackend: CogneeBackend = {
  async health(): Promise<CogneeResult> {
    try {
      const c = await getCognee();
      // Lightweight check: list datasets to verify connectivity.
      const datasets = await c.getDatasets();
      return {
        content: [{ type: "text", text: `SDK mode: connected. Datasets: ${fmt(datasets)}` }],
        details: { mode: "sdk", datasets },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `SDK mode: error — ${msg}` }],
        details: { mode: "sdk", error: msg },
      };
    }
  },

  async remember(params: RememberParams): Promise<CogneeResult> {
    const c = await getCognee();
    const dataset = params.dataset_name || "pi-default";
    const result = await c.remember({ type: "text", text: params.data }, dataset);
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "sdk", dataset },
    };
  },

  async recall(params: RecallParams): Promise<CogneeResult> {
    const c = await getCognee();
    const result = await c.recall(params.query);
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "sdk" },
    };
  },

  async forget(params: ForgetParams): Promise<CogneeResult> {
    const c = await getCognee();
    if (params.everything) {
      // Delete all datasets the user owns.
      const datasets = await c.getDatasets();
      for (const ds of datasets as Array<{ id: string }>) {
        await c.deleteDataset(ds.id);
      }
      return {
        content: [{ type: "text", text: "All datasets deleted." }],
        details: { mode: "sdk", everything: true },
      };
    }
    if (params.dataset) {
      await c.deleteDataset(params.dataset);
      return {
        content: [{ type: "text", text: `Dataset '${params.dataset}' deleted.` }],
        details: { mode: "sdk", dataset: params.dataset },
      };
    }
    return {
      content: [{ type: "text", text: "Specify a dataset name or everything=true." }],
      details: { mode: "sdk" },
    };
  },

  async datasets(): Promise<CogneeResult> {
    const c = await getCognee();
    const result = await c.getDatasets();
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "sdk" },
    };
  },

  async datasetData(params: DatasetDataParams): Promise<CogneeResult> {
    const c = await getCognee();
    const result = await c.getDatasetData(params.dataset_id);
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "sdk", dataset_id: params.dataset_id },
    };
  },

  async createDataset(params: CreateDatasetParams): Promise<CogneeResult> {
    const c = await getCognee();
    const result = await c.createDataset(params.name);
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "sdk", name: params.name },
    };
  },

  async clientInfo(): Promise<CogneeResult> {
    return {
      content: [{ type: "text", text: JSON.stringify({ client: { name: "pi-cognee", version: "0.1.0" }, mode: "sdk" }, null, 2) }],
      details: { mode: "sdk" },
    };
  },

  async cognifyFile(params: CognifyFileParams): Promise<CogneeResult> {
    const c = await getCognee();
    const buffer = Buffer.from(params.content_base64, "base64");
    const dataset = params.dataset_name || "pi-default";
    const result = await c.addAndCognify(
      { type: "binary", bytes: buffer, name: params.filename },
      dataset,
    );
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "sdk", filename: params.filename, dataset },
    };
  },
};
