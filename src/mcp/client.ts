/**
 * MCP bridge backend — communicates with a Cognee MCP server over
 * Streamable HTTP transport (JSON-RPC 2.0 + SSE).
 *
 * This is extracted from the existing cognee-api-client extension and
 * packaged for reuse.  Use when you already have a Cognee MCP server running.
 */

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
import { getMcpUrl } from "../config.js";

// ---------------------------------------------------------------------------
// MCP Streamable HTTP client
// ---------------------------------------------------------------------------

function parseSseStream(body: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        messages.push(JSON.parse(line.slice(6)));
      } catch {
        // skip unparseable data lines
      }
    }
  }
  return messages;
}

class McpClient {
  private baseUrl: string;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async ensureSession(signal?: AbortSignal): Promise<void> {
    if (this.sessionId) return;

    await this._rawPost(
      this._req("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-cognee", version: "0.1.0" },
      }),
      undefined,
      signal,
    );

    await this._rawPost(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      this.sessionId ?? undefined,
      signal,
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.ensureSession(signal);
    return this._rpc("tools/call", { name, arguments: args }, signal);
  }

  private async _rpc(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const body = await this._rawPost(
      this._req(method, params),
      this.sessionId!,
      signal,
    );
    const messages = parseSseStream(body);

    for (const msg of messages) {
      if (msg.id === undefined && msg.error) {
        throw new Error(`MCP error: ${JSON.stringify(msg.error)}`);
      }
      if (msg.result !== undefined) return msg.result;
      if (msg.error) {
        throw new Error(
          `MCP error ${(msg.error as Record<string, unknown>).code}: ${(msg.error as Record<string, unknown>).message}`,
        );
      }
    }

    return null;
  }

  private _req(method: string, params: Record<string, unknown>) {
    return {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    };
  }

  private async _rawPost(
    body: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId && sessionId !== "pending") {
      headers["mcp-session-id"] = sessionId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const combined = signal
      ? combineSignals(signal, controller.signal)
      : controller.signal;

    try {
      const res = await fetch(this.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: combined,
      });

      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;

      const text = await res.text();

      if (!res.ok) {
        const msgs = parseSseStream(text);
        const errMsg = msgs.find((m) => m.error);
        if (errMsg) {
          const e = errMsg.error as Record<string, unknown>;
          throw new Error(`MCP ${res.status}: ${e.message}`);
        }
        throw new Error(`MCP ${res.status}: ${text.slice(0, 500)}`);
      }

      return text;
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(
          `MCP request to ${this.baseUrl} timed out or was cancelled`,
        );
      }
      throw err;
    }
  }
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  if (a.aborted || b.aborted) controller.abort();
  return controller.signal;
}

// ---------------------------------------------------------------------------
// Client cache
// ---------------------------------------------------------------------------

const clientCache = new Map<string, McpClient>();

function getClient(): McpClient {
  const baseUrl = getMcpUrl();
  let client = clientCache.get(baseUrl);
  if (!client) {
    client = new McpClient(baseUrl);
    clientCache.set(baseUrl, client);
  }
  return client;
}

export function clearMcpCache(): void {
  clientCache.clear();
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

export const mcpBackend: CogneeBackend = {
  async health(): Promise<CogneeResult> {
    const client = getClient();
    await client.ensureSession();
    return {
      content: [
        {
          type: "text",
          text: `MCP mode: Cognee MCP server at ${getMcpUrl()} is reachable.`,
        },
      ],
      details: { mode: "mcp", url: getMcpUrl() },
    };
  },

  async remember(params: RememberParams): Promise<CogneeResult> {
    const client = getClient();
    const args: Record<string, unknown> = { data: params.data };
    if (params.dataset_name) args.dataset_name = params.dataset_name;
    if (params.session_id) args.session_id = params.session_id;
    if (params.custom_prompt) args.custom_prompt = params.custom_prompt;
    const result = await client.callTool("remember", args);
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "mcp" },
    };
  },

  async recall(params: RecallParams): Promise<CogneeResult> {
    const client = getClient();
    const args: Record<string, unknown> = { query: params.query };
    if (params.search_type) args.search_type = params.search_type;
    if (params.datasets) args.datasets = params.datasets;
    if (params.session_id) args.session_id = params.session_id;
    if (params.top_k !== undefined) args.top_k = params.top_k;
    const result = await client.callTool("recall", args);
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "mcp" },
    };
  },

  async forget(params: ForgetParams): Promise<CogneeResult> {
    const client = getClient();
    const args: Record<string, unknown> = {};
    if (params.dataset) args.dataset = params.dataset;
    if (params.everything) args.everything = true;
    const result = await client.callTool("forget", args);
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "mcp" },
    };
  },

  async datasets(): Promise<CogneeResult> {
    const client = getClient();
    const result = await client.callTool("list_datasets_json", {});
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "mcp" },
    };
  },

  async datasetData(params: DatasetDataParams): Promise<CogneeResult> {
    const client = getClient();
    const result = await client.callTool("list_dataset_data_json", {
      dataset_id: params.dataset_id,
    });
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "mcp", dataset_id: params.dataset_id },
    };
  },

  async createDataset(params: CreateDatasetParams): Promise<CogneeResult> {
    const client = getClient();
    const result = await client.callTool("create_dataset_json", {
      name: params.name,
    });
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "mcp", name: params.name },
    };
  },

  async clientInfo(): Promise<CogneeResult> {
    const client = getClient();
    const result = await client.callTool("get_client_info_json", {});
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "mcp" },
    };
  },

  async cognifyFile(params: CognifyFileParams): Promise<CogneeResult> {
    const client = getClient();
    const args: Record<string, unknown> = {
      filename: params.filename,
      content_base64: params.content_base64,
    };
    if (params.dataset_name) args.dataset_name = params.dataset_name;
    const result = await client.callTool("cognify_file", args);
    return {
      content: [{ type: "text", text: fmt(result) }],
      details: { mode: "mcp", filename: params.filename },
    };
  },
};
