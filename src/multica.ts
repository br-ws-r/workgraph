import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const UuidSchema = z.string().uuid();
const IssueReferenceSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9._-]*-\d+$/);

const MulticaIssueSchema = z.object({
  id: UuidSchema,
  workspace_id: UuidSchema,
  identifier: IssueReferenceSchema,
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

const MulticaWorkspaceSchema = z.object({
  id: UuidSchema,
  name: z.string().trim().min(1).max(256),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
}).passthrough();

const MulticaProjectSchema = z.object({
  id: UuidSchema,
  workspace_id: UuidSchema,
  title: z.string().trim().min(1).max(256),
}).passthrough();

const MulticaActivitySchema = z.object({
  id: UuidSchema,
  type: z.literal("activity"),
  action: z.string().trim().min(1).max(128),
  actor_id: z.string().max(256),
  actor_type: z.string().max(128),
  created_at: z.string().datetime({ offset: true }),
  details: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export type MulticaIssue = z.infer<typeof MulticaIssueSchema>;
export type MulticaActivity = z.infer<typeof MulticaActivitySchema>;
export type MulticaWorkspace = z.infer<typeof MulticaWorkspaceSchema>;
export type MulticaProject = z.infer<typeof MulticaProjectSchema>;

export interface MulticaActivityResult {
  activities: MulticaActivity[];
  truncated: boolean;
}

export interface InitiativeResolution {
  taskId?: string;
  workspace: MulticaWorkspace;
  issue: MulticaIssue;
  root: MulticaIssue;
  parent?: MulticaIssue;
  project?: MulticaProject;
  chain: string[];
}

export interface MulticaReaderOptions {
  binary?: string;
  run?: (command: string, args: string[]) => Promise<unknown>;
  runTimeline?: (command: string, args: string[]) => Promise<{ value: unknown; truncated: boolean }>;
  maxDepth?: number;
}

export class MulticaReader {
  readonly #binary: string;
  readonly #run: (command: string, args: string[]) => Promise<unknown>;
  readonly #runTimeline: (command: string, args: string[]) => Promise<{ value: unknown; truncated: boolean }>;
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
    this.#runTimeline = options.runTimeline ?? (options.run
      ? async (command, args) => ({ value: await options.run!(command, args), truncated: false })
      : async (command, args) => {
          const { stdout, stderr } = await execFileAsync(command, args, {
            encoding: "utf8", timeout: 10_000, maxBuffer: 5_000_000,
          });
          return { value: JSON.parse(stdout), truncated: /timeline truncated/i.test(stderr) };
        });
  }

  async issue(issueId: string, workspaceId?: string): Promise<MulticaIssue> {
    const expectedWorkspace = requiredUuid(workspaceId, "Multica workspace");
    const expectedIssue = issueReference(issueId);
    const result = await this.#run(this.#binary, [
      ...workspacePrefix(expectedWorkspace), "issue", "get", expectedIssue, "--output", "json",
    ]);
    const issue = parseIssue(result);
    if (UuidSchema.safeParse(expectedIssue).success) {
      if (issue.id.toLowerCase() !== expectedIssue.toLowerCase()) throw new Error("Multica returned a different issue ID");
    } else if (issue.identifier.toLowerCase() !== expectedIssue.toLowerCase()) {
      throw new Error("Multica returned a different issue identifier");
    }
    if (issue.workspace_id.toLowerCase() !== expectedWorkspace) {
      throw new Error(`Multica issue ${issue.id} belongs to a different workspace`);
    }
    return issue;
  }

  async workspace(workspaceId?: string): Promise<MulticaWorkspace> {
    const expectedWorkspace = requiredUuid(workspaceId, "Multica workspace");
    const result = await this.#run(this.#binary, ["workspace", "get", expectedWorkspace, "--output", "json"]);
    const workspace = MulticaWorkspaceSchema.parse(result);
    if (workspace.id.toLowerCase() !== expectedWorkspace) throw new Error("Multica returned a different workspace ID");
    return workspace;
  }

  async project(projectId: string, workspaceId?: string): Promise<MulticaProject> {
    const expectedWorkspace = requiredUuid(workspaceId, "Multica workspace");
    const expectedProject = requiredUuid(projectId, "Multica project");
    const result = await this.#run(this.#binary, [
      ...workspacePrefix(expectedWorkspace), "project", "get", expectedProject, "--output", "json",
    ]);
    const project = MulticaProjectSchema.parse(result);
    if (project.id.toLowerCase() !== expectedProject || project.workspace_id.toLowerCase() !== expectedWorkspace) {
      throw new Error("Multica returned a project outside the requested workspace");
    }
    return project;
  }

  async resolveIssue(issueId: string, workspaceId?: string): Promise<InitiativeResolution> {
    const expectedWorkspace = requiredUuid(workspaceId, "Multica workspace");
    const workspace = await this.workspace(expectedWorkspace);
    const issue = await this.issue(issueId, expectedWorkspace);
    let current = issue;
    let parent: MulticaIssue | undefined;
    const chain = [issue.id];
    const seen = new Set(chain.map((id) => id.toLowerCase()));
    for (let depth = 0; current.parent_issue_id; depth += 1) {
      if (depth >= this.#maxDepth) throw new Error("Multica parent chain exceeds the safety limit");
      const parentId = current.parent_issue_id;
      if (seen.has(parentId.toLowerCase())) throw new Error("Multica parent chain contains a cycle");
      current = await this.issue(parentId, expectedWorkspace);
      parent ??= current;
      chain.push(current.id);
      seen.add(current.id.toLowerCase());
    }
    const project = issue.project_id ? await this.project(issue.project_id, expectedWorkspace) : undefined;
    return { workspace, issue, root: current, parent, project, chain };
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
    const pageSize = 100;
    const records: unknown[] = [];
    for (let page = 0; page < 100; page += 1) {
      const result = await this.#run(this.#binary, [
        ...workspacePrefix(expectedWorkspace), "issue", "list",
        "--limit", String(pageSize), "--offset", String(page * pageSize), "--output", "json",
      ]);
      const pageRecords = Array.isArray(result)
        ? result
        : isRecord(result) && Array.isArray(result.issues) ? result.issues : undefined;
      if (!pageRecords) throw new Error("Multica issue list response has an unsupported shape");
      records.push(...pageRecords);
      const hasMore = isRecord(result) && typeof result.has_more === "boolean"
        ? result.has_more
        : pageRecords.length === pageSize;
      if (!hasMore) break;
      if (page === 99) throw new Error("Multica issue list exceeds the pagination safety limit");
    }
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

  async issueActivities(issueId: string, workspaceId?: string): Promise<MulticaActivityResult> {
    const expectedWorkspace = requiredUuid(workspaceId, "Multica workspace");
    const expectedIssue = requiredUuid(issueId, "Multica issue");
    const result = await this.#runTimeline(this.#binary, [
      ...workspacePrefix(expectedWorkspace), "issue", "timeline", expectedIssue,
      "--activity-only", "--output", "json",
    ]);
    if (!Array.isArray(result.value)) throw new Error("Multica issue activity response is not a list");
    return {
      activities: result.value.map((value) => MulticaActivitySchema.parse(value)),
      truncated: result.truncated,
    };
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

function issueReference(value: string): string {
  const trimmed = value.trim();
  const uuid = UuidSchema.safeParse(trimmed);
  return uuid.success ? uuid.data.toLowerCase() : IssueReferenceSchema.parse(trimmed).toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
