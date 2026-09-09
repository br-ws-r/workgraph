import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { openDatabase, type SqliteDatabase } from "./sqlite.js";
import { type MulticaReader, type MulticaIssue } from "./multica.js";

export const FollowupCondition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("issue_terminal"), issueId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("github_workflow"), url: z.string().regex(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*$/,
  ) }).strict(),
]);
export type FollowupCondition = z.infer<typeof FollowupCondition>;
export interface Followup {
  id: string; workspaceId: string; initiativeId: string; ownerId: string;
  ownerIdentifier: string; assignment: string; reason: string; condition: FollowupCondition;
  status: "waiting" | "dispatched" | "dispatching" | "cancelled";
  observation?: string;
}

export function terminal(issue: MulticaIssue): boolean {
  return ["done", "cancelled", "canceled"].includes((issue.status_category ?? issue.status).toLowerCase());
}
export function assignment(issue: MulticaIssue): string {
  if (!["agent", "squad"].includes(String(issue.assignee_type)) || typeof issue.assignee_id !== "string") {
    throw new Error("Follow-up owner needs an agent or squad assignment");
  }
  return `${issue.assignee_type}:${issue.assignee_id}`;
}

/** Durable notifications to resume an owner, never evidence of acceptance or permission to deploy. */
export class FollowupStore {
  readonly #db: SqliteDatabase;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = openDatabase(path);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS followups (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        record TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', observation TEXT
      );
      CREATE TABLE IF NOT EXISTS followup_owner_dispatch (
        workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, until_ms INTEGER NOT NULL,
        PRIMARY KEY(workspace_id,owner_id)
      );
      CREATE TABLE IF NOT EXISTS followup_executor (
        workspace_id TEXT PRIMARY KEY, last_poll_ms INTEGER NOT NULL
      );`);
  }
  add(input: Omit<Followup, "id" | "status" | "observation">): Followup {
    const condition = FollowupCondition.parse(input.condition);
    const id = createHash("sha256").update(JSON.stringify([
      input.workspaceId, input.initiativeId, input.ownerId, input.assignment, condition,
    ])).digest("hex");
    const record = { ...input, condition, id };
    this.#db.prepare("INSERT OR IGNORE INTO followups(id, workspace_id, owner_id, record) VALUES(?,?,?,?)")
      .run(id, input.workspaceId, input.ownerId, JSON.stringify(record));
    return this.list(input.workspaceId).find((item) => item.id === id)!;
  }
  list(workspace: string, owner?: string): Followup[] {
    return this.#db.prepare("SELECT record,status,observation FROM followups WHERE workspace_id=? AND (? IS NULL OR owner_id=?) ORDER BY rowid")
      .all(workspace, owner ?? null, owner ?? null).map((row) => ({
        ...JSON.parse(String(row.record)), status: row.status, observation: row.observation ?? undefined,
      }));
  }
  observe(id: string, observation: string): void {
    this.#db.prepare("UPDATE followups SET observation=? WHERE id=?").run(observation, id);
  }
  transition(id: string, from: Followup["status"], to: Followup["status"]): boolean {
    return Number(this.#db.prepare("UPDATE followups SET status=? WHERE id=? AND status=?").run(to, id, from).changes) === 1;
  }
  claim(watch: Followup): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.#db.prepare("SELECT id FROM followups WHERE workspace_id=? AND owner_id=? AND status='dispatching'")
        .get(watch.workspaceId, watch.ownerId);
      const recent = this.#db.prepare("SELECT until_ms FROM followup_owner_dispatch WHERE workspace_id=? AND owner_id=?")
        .get(watch.workspaceId, watch.ownerId);
      if (active || Number(recent?.until_ms ?? 0) > Date.now()) { this.#db.exec("COMMIT"); return false; }
      const claimed = this.transition(watch.id, "waiting", "dispatching");
      if (claimed) this.#db.prepare(`INSERT INTO followup_owner_dispatch VALUES(?,?,?)
        ON CONFLICT(workspace_id,owner_id) DO UPDATE SET until_ms=excluded.until_ms`)
        .run(watch.workspaceId, watch.ownerId, Date.now() + 60_000);
      this.#db.exec("COMMIT"); return claimed;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  heartbeat(workspace: string): void {
    this.#db.prepare(`INSERT INTO followup_executor VALUES(?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET last_poll_ms=excluded.last_poll_ms`).run(workspace, Date.now());
  }
  executorStatus(workspace: string) {
    const row = this.#db.prepare("SELECT last_poll_ms FROM followup_executor WHERE workspace_id=?").get(workspace);
    const lastPoll = row ? Number(row.last_poll_ms) : undefined;
    return { recentlyObserved: lastPoll !== undefined && Date.now() - lastPoll < 300_000,
      lastPoll: lastPoll === undefined ? undefined : new Date(lastPoll).toISOString() };
  }
  close(): void { this.#db.close(); }
}

export async function workflowConclusion(url: string): Promise<string | undefined> {
  const parsed = FollowupCondition.parse({ kind: "github_workflow", url });
  if (parsed.kind !== "github_workflow") throw new Error("Invalid workflow condition");
  const [, owner, repo, , , run] = new URL(parsed.url).pathname.split("/");
  const { stdout } = await promisify(execFile)("gh", ["api", `repos/${owner}/${repo}/actions/runs/${run}`], {
    timeout: 15_000, maxBuffer: 1024 * 1024, encoding: "utf8",
  });
  const result = z.object({ id: z.number(), html_url: z.string(), status: z.string(), conclusion: z.string().nullable() }).parse(JSON.parse(stdout));
  if (String(result.id) !== run || result.html_url !== url) throw new Error("GitHub returned a different workflow run");
  return result.status === "completed" && result.conclusion ? result.conclusion : undefined;
}

/** Run from a scheduler with --dispatch; without it this only observes readiness. */
export async function reconcileFollowups(store: FollowupStore, multica: MulticaReader,
  workspaceId: string, dispatch = false, workflow = workflowConclusion): Promise<Followup[]> {
  const workspace = await multica.workspace(workspaceId);
  if (dispatch) store.heartbeat(workspace.id);
  for (const watch of store.list(workspace.id)) {
    if (watch.status !== "waiting") continue;
    try {
      const owner = await multica.resolveIssue(watch.ownerId, workspace.id);
      if (terminal(owner.issue)) {
        store.transition(watch.id, "waiting", "cancelled");
        continue;
      }
      if (owner.root.id !== watch.initiativeId || assignment(owner.issue) !== watch.assignment) {
        store.observe(watch.id, "owner_scope_or_assignment_changed");
        continue;
      }
      let observation: string;
      if (watch.condition.kind === "issue_terminal") {
        const target = await multica.resolveIssue(watch.condition.issueId, workspace.id);
        if (target.root.id !== watch.initiativeId || !target.chain.includes(watch.ownerId)) {
          store.observe(watch.id, "dependency_scope_changed");
          continue;
        }
        if (!terminal(target.issue)) { store.observe(watch.id, "waiting_for_issue"); continue; }
        observation = `${target.issue.identifier}: ${target.issue.status_category ?? target.issue.status}`;
      } else {
        const conclusion = await workflow(watch.condition.url);
        if (!conclusion) { store.observe(watch.id, "waiting_for_workflow"); continue; }
        // Failed/cancelled deployments also wake the owner to recover, never mark an issue done.
        observation = `workflow_completed: ${conclusion}`;
      }
      store.observe(watch.id, observation);
      if (!dispatch) continue;
      if ((await multica.activeRuns(watch.ownerId, workspace.id)).length) {
        store.observe(watch.id, `owner_busy; ${observation}`);
        continue;
      }
      // CAS excludes overlapping workers. A crash/ambiguous HTTP outcome stays dispatching
      // for operator reconciliation: Multica rerun does not offer an idempotency key.
      if (!store.claim(watch)) continue;
      try {
        await multica.rerun(watch.ownerId, workspace.id);
        store.transition(watch.id, "dispatching", "dispatched");
      } catch { store.observe(watch.id, "dispatch_outcome_unknown; inspect Multica runs before retrying"); }
    } catch { store.observe(watch.id, "read_failed; retry_on_next_poll"); }
  }
  return store.list(workspace.id);
}
