import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MulticaIssue {
  id: string;
  title?: string;
  status?: string;
  parent_issue_id?: string | null;
  project_id?: string | null;
  updated_at?: string;
  [key: string]: unknown;
}

export interface InitiativeResolution {
  taskId?: string;
  issue: MulticaIssue;
  root: MulticaIssue;
  chain: string[];
}

export interface MulticaReaderOptions {
  binary?: string;
  run?: (command: string, args: string[]) => Promise<unknown>;
  maxDepth?: number;
}

export class MulticaReader {
  readonly #binary: string;
  readonly #run: (command: string, args: string[]) => Promise<unknown>;
  readonly #maxDepth: number;

  constructor(options: MulticaReaderOptions = {}) {
    this.#binary = options.binary ?? "multica";
    this.#maxDepth = options.maxDepth ?? 32;
    this.#run = options.run ?? (async (command, args) => {
      const { stdout } = await execFileAsync(command, args, {
        encoding: "utf8", timeout: 10_000, maxBuffer: 5_000_000,
      });
      return JSON.parse(stdout);
    });
  }

  async issue(issueId: string, workspaceId?: string): Promise<MulticaIssue> {
    const result = await this.#run(this.#binary, [
      ...workspacePrefix(workspaceId), "issue", "get", issueId, "--output", "json",
    ]);
    return parseIssue(result);
  }

  async resolveIssue(issueId: string, workspaceId?: string): Promise<InitiativeResolution> {
    const issue = await this.issue(issueId, workspaceId);
    let current = issue;
    const chain = [issue.id];
    const seen = new Set(chain);
    for (let depth = 0; current.parent_issue_id; depth += 1) {
      if (depth >= this.#maxDepth) throw new Error("Multica parent chain exceeds the safety limit");
      const parentId = current.parent_issue_id;
      if (seen.has(parentId)) throw new Error("Multica parent chain contains a cycle");
      current = await this.issue(parentId, workspaceId);
      chain.push(current.id);
      seen.add(current.id);
    }
    return { issue, root: current, chain };
  }

  async resolveTask(taskId: string, agentId: string, workspaceId?: string): Promise<InitiativeResolution> {
    const result = await this.#run(this.#binary, [
      ...workspacePrefix(workspaceId), "agent", "tasks", agentId, "--output", "json",
    ]);
    if (!Array.isArray(result)) throw new Error("Multica task response is not a list");
    const task = result.find((value) => isRecord(value) && String(value.id) === taskId);
    if (!isRecord(task) || typeof task.issue_id !== "string") throw new Error(`Multica task ${taskId} has no issue`);
    return { ...(await this.resolveIssue(task.issue_id, workspaceId)), taskId };
  }

  async recentRootInitiatives(workspaceId?: string, limit = 10): Promise<MulticaIssue[]> {
    const result = await this.#run(this.#binary, [
      ...workspacePrefix(workspaceId), "issue", "list", "--output", "json",
    ]);
    const records = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.issues) ? result.issues : [];
    return records.filter(isRecord).map(parseIssue).filter((issue) =>
      !issue.parent_issue_id && !["done", "cancelled", "canceled"].includes(issue.status?.toLowerCase() ?? ""),
    ).sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""))).slice(0, limit);
  }
}

export async function resolveFromEnvironment(
  reader: MulticaReader,
  env: NodeJS.ProcessEnv,
  explicitInitiative?: string,
): Promise<InitiativeResolution | undefined> {
  const workspaceId = env.MULTICA_WORKSPACE_ID?.trim();
  if (explicitInitiative) {
    const resolved = await reader.resolveIssue(explicitInitiative, workspaceId);
    if (resolved.issue.id !== resolved.root.id) throw new Error("--initiative must identify a root Multica issue");
    return resolved;
  }
  const issueId = env.MULTICA_ISSUE_ID?.trim();
  if (issueId) return reader.resolveIssue(issueId, workspaceId);
  const taskId = env.MULTICA_TASK_ID?.trim();
  const agentId = env.MULTICA_AGENT_ID?.trim();
  if (taskId && agentId) return reader.resolveTask(taskId, agentId, workspaceId);
  return undefined;
}

function workspacePrefix(workspaceId?: string): string[] {
  return workspaceId?.trim() ? ["--workspace-id", workspaceId.trim()] : [];
}

function parseIssue(value: unknown): MulticaIssue {
  if (!isRecord(value) || typeof value.id !== "string") throw new Error("Invalid Multica issue response");
  return value as MulticaIssue;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
