import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { outboxPath, readCogneeConfig, rememberTimeout } from "./config.js";
import { CogneeApiClient } from "./cognee.js";
import { MulticaReader } from "./multica.js";
import { datasetForWorkspace } from "./schema.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  detail: string;
}

/** Read-only preflight. Never opens the outbox, changes host settings, or ingests data. */
export async function doctor(env: NodeJS.ProcessEnv = process.env, online = false): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let config;
  try {
    config = readCogneeConfig(env);
    rememberTimeout(env);
    checks.push(config
      ? { name: "cognee-config", status: "ok", detail: `${config.serviceUrl} (${config.authScheme})` }
      : { name: "cognee-config", status: "warning", detail: "COGNEE_SERVICE_URL is unset; semantic memory is disabled" });
  } catch (error) {
    checks.push({ name: "cognee-config", status: "error", detail: (error as Error).message });
  }
  const path = outboxPath(env);
  try {
    await access(dirname(path), constants.W_OK);
    checks.push({ name: "outbox-directory", status: "ok", detail: path });
  } catch {
    checks.push({ name: "outbox-directory", status: "warning", detail: `${dirname(path)} is absent or not writable; provision a persistent directory before launch` });
  }
  if (!online) return checks;

  const reader = new MulticaReader({ binary: env.MULTICA_BIN?.trim() || "multica", env });
  try {
    const workspace = await reader.workspace(env.MULTICA_WORKSPACE_ID);
    checks.push({ name: "multica-workspace", status: "ok", detail: `${workspace.slug} -> ${datasetForWorkspace(workspace.slug)}` });
  } catch {
    checks.push({ name: "multica-workspace", status: "error", detail: "Workspace verification failed; check Multica binary, server, authentication and MULTICA_WORKSPACE_ID" });
  }
  if (config) {
    try {
      await new CogneeApiClient(config).health();
      checks.push({ name: "cognee-health", status: "ok", detail: "Health endpoint responded; this does not verify ingestion or dataset access" });
    } catch {
      checks.push({ name: "cognee-health", status: "error", detail: "Health request failed; check endpoint, authentication, TLS and timeout" });
    }
  }
  return checks;
}
