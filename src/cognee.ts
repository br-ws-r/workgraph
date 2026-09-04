import { EXTRACTION_PROMPT, boundText, type MemoryRecord } from "./schema.js";

export type CogneeAuthScheme = "x-api-key" | "bearer" | "none";

export interface CogneeClientOptions {
  serviceUrl: string;
  apiKey?: string;
  tenantId?: string;
  authScheme?: CogneeAuthScheme;
  timeoutMs?: number;
  rememberTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface CogneeRecallOptions {
  topK?: number;
  nodeNames?: string[];
  signal?: AbortSignal;
}

export interface CogneeRecallEntry {
  source: string;
  kind: string;
  searchType: string;
  text: string;
  datasetId?: string;
  datasetName?: string;
  metadata: Record<string, unknown>;
}

export class CogneeApiClient {
  readonly #baseUrl: URL;
  readonly #apiKey?: string;
  readonly #tenantId?: string;
  readonly #authScheme: CogneeAuthScheme;
  readonly #timeoutMs: number;
  readonly #rememberTimeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: CogneeClientOptions) {
    this.#baseUrl = new URL(options.serviceUrl.endsWith("/") ? options.serviceUrl : `${options.serviceUrl}/`);
    if ((options.authScheme ?? "x-api-key") !== "none" && !options.apiKey?.trim()) {
      throw new Error("Cognee API key is required unless authScheme is none");
    }
    this.#apiKey = options.apiKey;
    this.#tenantId = options.tenantId;
    this.#authScheme = options.authScheme ?? "x-api-key";
    const timeoutMs = options.timeoutMs ?? 3000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100) throw new Error("Cognee timeout must be at least 100 ms");
    this.#timeoutMs = Math.trunc(timeoutMs);
    const rememberTimeoutMs = options.rememberTimeoutMs ?? 120_000;
    if (!Number.isFinite(rememberTimeoutMs) || rememberTimeoutMs < 100) throw new Error("Cognee Remember timeout must be at least 100 ms");
    this.#rememberTimeoutMs = Math.trunc(rememberTimeoutMs);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async health(signal?: AbortSignal): Promise<unknown> {
    return this.#request("health", { signal });
  }

  async recall(query: string, dataset: string, options: CogneeRecallOptions = {}): Promise<CogneeRecallEntry[]> {
    const result = await this.#request("api/v1/recall", {
      method: "POST",
      signal: options.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        datasets: [dataset],
        search_type: "CHUNKS",
        node_name: options.nodeNames ?? [],
        top_k: Math.min(20, Math.max(1, Math.trunc(options.topK ?? 8))),
        only_context: false,
        include_references: false,
      }),
    });
    if (!Array.isArray(result)) throw new Error("Cognee Recall response is not a list");
    const entries = result.map(normalizeRecallEntry).filter((entry): entry is CogneeRecallEntry => entry !== undefined);
    if (result.length > 0 && entries.length === 0) throw new Error("Cognee Recall response has an unsupported shape");
    return entries;
  }

  async remember(record: MemoryRecord, dataset: string, idempotencyKey: string, signal?: AbortSignal): Promise<unknown> {
    const form = new FormData();
    const filename = `${record.entity_id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
    form.append("data", new Blob([JSON.stringify(record)], { type: "application/json" }), filename);
    form.append("datasetName", dataset);
    for (const nodeSet of record.node_sets) form.append("node_set", nodeSet);
    form.append("custom_prompt", EXTRACTION_PROMPT);
    form.append("chunk_size", "16384");
    form.append("run_in_background", "false");
    const result = await this.#request("api/v1/remember", {
      method: "POST",
      signal,
      headers: { "Idempotency-Key": idempotencyKey },
      body: form,
    }, this.#rememberTimeoutMs);
    if (!isRecord(result) || result.status !== "completed") {
      const detail = isRecord(result) ? String(result.error ?? result.status ?? "invalid response") : "invalid response";
      throw new Error(`Cognee Remember did not complete: ${boundText(detail, 1000)}`);
    }
    return result;
  }

  async #request(path: string, init: RequestInit = {}, timeoutMs = this.#timeoutMs): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const headers = new Headers(init.headers);
    if (this.#authScheme === "bearer") headers.set("Authorization", `Bearer ${this.#apiKey}`);
    else if (this.#authScheme === "x-api-key") headers.set("X-Api-Key", this.#apiKey!);
    if (this.#tenantId) headers.set("X-Tenant-Id", this.#tenantId);
    const response = await this.#fetch(new URL(path, this.#baseUrl), { ...init, headers, signal });
    if (!response.ok) throw new Error(`Cognee API ${response.status}: ${await response.text()}`.slice(0, 1200));
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("json") ? response.json() : response.text();
  }
}

export function createCogneeClientFromEnv(env: NodeJS.ProcessEnv = process.env): CogneeApiClient | undefined {
  const serviceUrl = env.COGNEE_SERVICE_URL?.trim();
  const apiKey = env.COGNEE_API_KEY?.trim();
  if (!serviceUrl) return undefined;
  const configuredScheme = env.COGNEE_AUTH_SCHEME?.trim();
  const authScheme = configuredScheme === "bearer" || configuredScheme === "none" ? configuredScheme : "x-api-key";
  if (authScheme !== "none" && !apiKey) return undefined;
  const configuredTimeout = env.WORKGRAPH_COGNEE_TIMEOUT_MS?.trim();
  const timeoutMs = configuredTimeout ? Number(configuredTimeout) : 3000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100) return undefined;
  const tenantId = env.COGNEE_TENANT_ID?.trim() || undefined;
  const configuredRememberTimeout = env.WORKGRAPH_COGNEE_REMEMBER_TIMEOUT_MS?.trim();
  const rememberTimeoutMs = configuredRememberTimeout ? Number(configuredRememberTimeout) : 120_000;
  if (!Number.isFinite(rememberTimeoutMs) || rememberTimeoutMs < 100) return undefined;
  return new CogneeApiClient({ serviceUrl, apiKey, tenantId, authScheme, timeoutMs, rememberTimeoutMs });
}

function normalizeRecallEntry(value: unknown): CogneeRecallEntry | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  return {
    source: typeof value.source === "string" ? value.source : "unknown",
    kind: typeof value.kind === "string" ? value.kind : "unknown",
    searchType: typeof value.search_type === "string" ? value.search_type : "unknown",
    text: value.text,
    datasetId: optionalString(value.dataset_id),
    datasetName: optionalString(value.dataset_name),
    metadata: isRecord(value.metadata) ? value.metadata : {},
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
