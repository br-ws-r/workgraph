import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const UuidSchema = z.string().uuid();

const MulticaIssueSchema = z.object({
  id: UuidSchema,
  workspace_id: UuidSchema,
  identifier: z.string().trim().min(1),
  status: z.string().trim().min(1),
  parent_issue_id: UuidSchema.nullable(),
  project_id: UuidSchema.nullable(),
  stage: z.number().int().positive().nullable(),
  status_category: z.string().trim().min(1).optional(),
  title: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();

const MulticaTaskSchema = z.object({
  id: UuidSchema,
  agent_id: UuidSchema,
  workspace_id: UuidSchema,
  issue_id: z.string().trim().min(1),
}).passthrough();

export type MulticaIssue = z.infer<typeof MulticaIssueSchema>;

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
    const expectedWorkspace = requiredUuid(workspaceId, "Multica workspace");
    const expectedIssue = requiredUuid(issueId, "Multica issue");
    const result = await this.#run(this.#binary, [
      ...workspacePrefix(expectedWorkspace), "issue", "get", expectedIssue, "--output", "json",
    ]);
    const issue = parseIssue(result);
    if (issue.id.toLowerCase() !== expectedIssue) throw new Error("Multica returned a different issue ID");
    if (issue.workspace_id.toLowerCase() !== expectedWorkspace) {
      throw new Error(`Multica issue ${issue.id} belongs to a different workspace`);
    }
    return issue;
  }

  async resolveIssue(issueId: string, workspaceId?: string): Promise<InitiativeResolution> {
    const expectedWorkspace = requiredUuid(workspaceId, "Multica workspace");
    const issue = await this.issue(issueId, expectedWorkspace);
    let current = issue;
    const chain = [issue.id];
    const seen = new Set(chain.map((id) => id.toLowerCase()));
    for (let depth = 0; current.parent_issue_id; depth += 1) {
      if (depth >= this.#maxDepth) throw new Error("Multica parent chain exceeds the safety limit");
      const parentId = current.parent_issue_id;
      if (seen.has(parentId.toLowerCase())) throw new Error("Multica parent chain contains a cycle");
      current = await this.issue(parentId, expectedWorkspace);
      chain.push(current.id);
      seen.add(current.id.toLowerCase());
    }
    return { issue, root: current, chain };
  }

  async resolveTask(taskId: string, agentId: string, workspaceId?: string): Promise<InitiativeResolution> {
    const expectedWorkspace = requiredUuid(workspaceId, "Multica workspace");
    const expectedTask = requiredUuid(taskId, "Multica task");
    const expectedAgent = requiredUuid(agentId, "Multica agent");
    const result = await this.#run(this.#binary, [
      ...workspacePrefix(expectedWorkspace), "agent", "tasks", expectedAgent, "--output", "json",
    ]);
    if (!Array.isArray(result)) throw new Error("Multica task response is not a list");
    const candidate = result.find((value) => isRecord(value)
      && typeof value.id === "string" && value.id.toLowerCase() === expectedTask);
    if (!candidate) throw new Error(`Multica task ${expectedTask} was not found`);
    const task = MulticaTaskSchema.parse(candidate);
    if (task.id.toLowerCase() !== expectedTask) throw new Error(`Multica task ${expectedTask} was not found`);
    if (task.agent_id.toLowerCase() !== expectedAgent) throw new Error(`Multica task ${expectedTask} belongs to a different agent`);
    if (task.workspace_id.toLowerCase() !== expectedWorkspace) throw new Error(`Multica task ${expectedTask} belongs to a different workspace`);
    return { ...(await this.resolveIssue(task.issue_id, expectedWorkspace)), taskId: task.id };
  }

  async recentRootInitiatives(workspaceId?: string, limit = 10): Promise<MulticaIssue[]> {
    const expectedWorkspace = requiredUuid(workspaceId, "Multica workspace");
    const result = await this.#run(this.#binary, [
      ...workspacePrefix(expectedWorkspace), "issue", "list", "--output", "json",
    ]);
    const records = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.issues) ? result.issues : [];
    return records.map(parseIssue).map((issue) => {
      if (issue.workspace_id.toLowerCase() !== expectedWorkspace) {
        throw new Error(`Multica issue ${issue.id} belongs to a different workspace`);
      }
      return issue;
    }).filter((issue) => {
      const category = issue.status_category?.toLowerCase() || issue.status.toLowerCase();
      return !issue.parent_issue_id && !["done", "cancelled", "canceled"].includes(category);
    }).sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""))).slice(0, limit);
  }
}

export async function resolveFromEnvironment(
  reader: MulticaReader,
  env: NodeJS.ProcessEnv,
  explicitInitiative?: string,
): Promise<InitiativeResolution | undefined> {
  const workspaceId = requiredUuid(env.MULTICA_WORKSPACE_ID, "MULTICA_WORKSPACE_ID");
  const taskId = env.MULTICA_TASK_ID?.trim();
  const agentId = env.MULTICA_AGENT_ID?.trim();

  if (taskId || agentId) {
    if (!taskId || !agentId) throw new Error("MULTICA_TASK_ID and MULTICA_AGENT_ID must be provided together");
    if (explicitInitiative) throw new Error("--initiative cannot override a managed Multica task");
    const resolved = await reader.resolveTask(taskId, agentId, workspaceId);
    const issueId = env.MULTICA_ISSUE_ID?.trim();
    if (issueId && requiredUuid(issueId, "MULTICA_ISSUE_ID") !== resolved.issue.id.toLowerCase()) {
      throw new Error("MULTICA_ISSUE_ID does not match the managed task issue");
    }
    return resolved;
  }

  if (explicitInitiative) {
    const resolved = await reader.resolveIssue(explicitInitiative, workspaceId);
    if (resolved.issue.id !== resolved.root.id) throw new Error("--initiative must identify a root Multica issue");
    return resolved;
  }
  const issueId = env.MULTICA_ISSUE_ID?.trim();
  if (issueId) return reader.resolveIssue(issueId, workspaceId);
  return undefined;
}

function workspacePrefix(workspaceId: string): string[] {
  return ["--workspace-id", workspaceId];
}

function parseIssue(value: unknown): MulticaIssue {
  return MulticaIssueSchema.parse(value);
}

function requiredUuid(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return UuidSchema.parse(value.trim()).toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
