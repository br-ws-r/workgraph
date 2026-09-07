import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_TIMEOUT_MS = 3000;
export const DEFAULT_REMEMBER_TIMEOUT_MS = 120_000;
export type CogneeAuthScheme = "x-api-key" | "bearer" | "none";

export interface CogneeConfig {
  serviceUrl: string;
  authScheme: CogneeAuthScheme;
  apiKey?: string;
  tenantId?: string;
  timeoutMs: number;
  rememberTimeoutMs: number;
}

export function timeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 2_147_483_647) {
    throw new Error(`${label} must be an integer between 100 and 2147483647 ms`);
  }
  return value;
}

export function rememberTimeout(env: NodeJS.ProcessEnv): number {
  return timeout(Number(env.WORKGRAPH_COGNEE_REMEMBER_TIMEOUT_MS?.trim() || DEFAULT_REMEMBER_TIMEOUT_MS),
    "WORKGRAPH_COGNEE_REMEMBER_TIMEOUT_MS");
}

export function cogneeBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("COGNEE_SERVICE_URL must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("COGNEE_SERVICE_URL must use HTTP(S), without credentials, query, or fragment");
  }
  if (/\/api\/v1\/?$/.test(url.pathname)) {
    throw new Error("COGNEE_SERVICE_URL must be the base URL without /api/v1");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

/** An absent URL disables Cognee; a supplied but invalid configuration is an error. */
export function readCogneeConfig(env: NodeJS.ProcessEnv = process.env): CogneeConfig | undefined {
  const serviceUrl = env.COGNEE_SERVICE_URL?.trim();
  if (!serviceUrl) return undefined;
  const authScheme = env.COGNEE_AUTH_SCHEME?.trim() || "x-api-key";
  if (authScheme !== "x-api-key" && authScheme !== "bearer" && authScheme !== "none") {
    throw new Error("COGNEE_AUTH_SCHEME must be x-api-key, bearer, or none");
  }
  const apiKey = env.COGNEE_API_KEY?.trim() || undefined;
  if (authScheme !== "none" && !apiKey) throw new Error("COGNEE_API_KEY is required unless COGNEE_AUTH_SCHEME is none");
  return {
    serviceUrl: cogneeBaseUrl(serviceUrl).href,
    authScheme,
    apiKey,
    tenantId: env.COGNEE_TENANT_ID?.trim() || undefined,
    timeoutMs: timeout(Number(env.WORKGRAPH_COGNEE_TIMEOUT_MS?.trim() || DEFAULT_TIMEOUT_MS), "WORKGRAPH_COGNEE_TIMEOUT_MS"),
    rememberTimeoutMs: rememberTimeout(env),
  };
}

export function outboxPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  const dataDir = env.WORKGRAPH_DATA_DIR?.trim() || join(dataHome, "workgraph");
  return join(dataDir, "workgraph-workspace-v3.db");
}
