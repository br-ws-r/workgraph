/**
 * Shared types for pi-cognee.
 */

/** Operating mode for the Cognee backend. */
export type CogneeMode = "sdk" | "mcp";

/** Configuration persisted to disk. */
export interface CogneeConfig {
  mode: CogneeMode;
  /** MCP server URL (MCP mode only). */
  mcpUrl?: string;
  /** LLM model for SDK mode. */
  llmModel?: string;
  /** LLM API key for SDK mode. */
  llmApiKey?: string;
  /** Embedding provider for SDK mode. */
  embeddingProvider?: string;
  /** Embedding model for SDK mode. */
  embeddingModel?: string;
  /** Vector DB provider for SDK mode. */
  vectorDbProvider?: string;
  /** Graph DB provider for SDK mode. */
  graphDbProvider?: string;
}

/** Unified result from any backend operation. */
export interface CogneeResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/** Backend interface — both SDK and MCP clients implement this. */
export interface CogneeBackend {
  health(): Promise<CogneeResult>;
  remember(params: RememberParams): Promise<CogneeResult>;
  recall(params: RecallParams): Promise<CogneeResult>;
  forget(params: ForgetParams): Promise<CogneeResult>;
  datasets(): Promise<CogneeResult>;
  datasetData(params: DatasetDataParams): Promise<CogneeResult>;
  createDataset(params: CreateDatasetParams): Promise<CogneeResult>;
  clientInfo(): Promise<CogneeResult>;
  cognifyFile(params: CognifyFileParams): Promise<CogneeResult>;
}

export interface RememberParams {
  data: string;
  dataset_name?: string;
  session_id?: string;
  custom_prompt?: string;
}

export interface RecallParams {
  query: string;
  search_type?: string;
  datasets?: string;
  session_id?: string;
  top_k?: number;
}

export interface ForgetParams {
  dataset?: string;
  everything?: boolean;
}

export interface DatasetDataParams {
  dataset_id: string;
}

export interface CreateDatasetParams {
  name: string;
}

export interface CognifyFileParams {
  filename: string;
  content_base64: string;
  dataset_name?: string;
}
