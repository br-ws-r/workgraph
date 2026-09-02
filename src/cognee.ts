import type { MemoryRecord } from "./schema.js";

export type CogneeAuthScheme = "x-api-key" | "bearer" | "none";

export interface CogneeClientOptions {
  serviceUrl: string;
  apiKey?: string;
  tenantId?: string;
  authScheme?: CogneeAuthScheme;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class CogneeApiClient {
  readonly #baseUrl: URL;
  readonly #apiKey?: string;
  readonly #tenantId?: string;
  readonly #authScheme: CogneeAuthScheme;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: CogneeClientOptions) {
    this.#baseUrl = new URL(options.serviceUrl.endsWith("/") ? options.serviceUrl : `${options.serviceUrl}/`);
    if ((options.authScheme ?? "x-api-key") !== "none" && !options.apiKey?.trim()) {
      throw new Error("Cognee API key is required unless authScheme is none");
    }
    this.#apiKey = options.apiKey;
    this.#tenantId = options.tenantId;
    this.#authScheme = options.authScheme ?? "x-api-key";
    this.#timeoutMs = Math.max(100, options.timeoutMs ?? 3000);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async health(signal?: AbortSignal): Promise<unknown> {
    return this.#request("health", { signal });
  }

  async recall(query: string, dataset: string, topK = 8, signal?: AbortSignal): Promise<unknown> {
    return this.#request("api/v1/search", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, datasets: [dataset], search_type: "GRAPH_COMPLETION", top_k: topK }),
    });
  }

  async remember(record: MemoryRecord, dataset: string, idempotencyKey: string, signal?: AbortSignal): Promise<unknown> {
    const form = new FormData();
    const filename = `${record.entity_id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
    form.append("data", new Blob([JSON.stringify(record)], { type: "application/json" }), filename);
    form.append("datasetName", dataset);
    form.append("run_in_background", "true");
    return this.#request("api/v1/remember", {
      method: "POST",
      signal,
      headers: { "Idempotency-Key": idempotencyKey },
      body: form,
    });
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
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
  const timeoutMs = Number(env.WORKGRAPH_COGNEE_TIMEOUT_MS ?? "3000");
  const tenantId = env.COGNEE_TENANT_ID?.trim() || undefined;
  return new CogneeApiClient({ serviceUrl, apiKey, tenantId, authScheme, timeoutMs });
}
