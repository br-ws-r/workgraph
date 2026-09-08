import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { summarizeHandoff } from "../src/activity.js";
import { fitMemories } from "../src/extension.js";
import { WorkgraphOutbox } from "../src/outbox.js";
import { WorkgraphRuntime } from "../src/runtime.js";
import { MulticaReader, type MulticaHandoff } from "../src/multica.js";
import type { CogneeApiClient } from "../src/cognee.js";
import { SCHEMA_VERSION, EXTRACTION_PROMPT_VERSION } from "../src/schema.js";

const workspace = "00000000-0000-4000-8000-000000000010";
const issueId = "00000000-0000-4000-8000-000000000001";
const task = "00000000-0000-4000-8000-000000000003";
const issue = { id: issueId, workspace_id: workspace, identifier: "B-225", status: "in_progress",
  parent_issue_id: null, project_id: null, stage: null };
const resolution = { workspace: { id: workspace, name: "BRWSR", slug: "brwsr" }, root: issue, issue, chain: [issueId] };
const handoff: MulticaHandoff = { id: task, type: "comment", actor_type: "agent", source_task_id: task,
  created_at: "2026-09-08T10:00:00Z", content: "IN PROGRESS. Retry starvation caused missing images. Fixed ordering; 180 tests pass. PR #24 is ready for review.\n\n```\nraw log must not be copied\n```" };
function fixture(recall = vi.fn(async () => [] as unknown[])) {
  const multica = new MulticaReader({ run: vi.fn() });
  multica.resolveIssue = vi.fn(async () => resolution);
  multica.issueActivities = vi.fn(async () => ({ activities: [], handoffs: [] as MulticaHandoff[], truncated: false }));
  const outbox = new WorkgraphOutbox(join(mkdtempSync(join(tmpdir(), "memory-quality-")), "outbox.db"));
  const remember = vi.fn(async () => ({ status: "completed" }));
  const runtime = new WorkgraphRuntime({ env: { MULTICA_WORKSPACE_ID: workspace }, multica, outbox,
    cognee: { recall, remember } as unknown as CogneeApiClient });
  runtime.lockInitiative(resolution);
  vi.spyOn(runtime, "scheduleFlush").mockImplementation(() => undefined);
  return { runtime, multica, outbox, remember, recall };
}
const record = { schema_version: SCHEMA_VERSION, extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
  workspace_id: workspace, workspace_identifier: "brwsr", initiative_id: issueId, initiative_identifier: "B-225",
  issue_id: issueId, issue_identifier: "B-225", entity_type: "Handoff", authority: "observed",
  entity_identifier: "handoff:fix-images", entity_label: "Image fix handoff", summary: "Retry starvation fixed; PR #24.",
  relations: [], node_sets: ["initiative:B-225", "type:handoff", "authority:observed"],
  source: "multica://issues/B-225/comments/example", observed_at: "2026-09-08T10:00:00Z" };

describe("useful memory without replay or transcript capture", () => {
  it("captures new agent handoffs once, retaining diagnosis and provenance, not generic activity documents", async () => {
    const f = fixture();
    await f.runtime.reconcileActivity(); // Empty initial baseline.
    f.multica.issueActivities = vi.fn(async () => ({ activities: [{ id: issueId, type: "activity" as const,
      action: "task_completed", actor_id: task, actor_type: "agent", details: {}, created_at: handoff.created_at }],
      handoffs: [handoff], truncated: false }));
    await f.runtime.reconcileActivity();
    await f.runtime.reconcileActivity();
    const pending = f.outbox.pending(workspace);
    expect(pending).toHaveLength(1);
    expect(pending[0].memoryRecord).toMatchObject({ entity_type: "Handoff", authority: "observed",
      source_revision: task, source: `multica://issues/B-225/comments/${task}` });
    expect(pending[0].memoryRecord!.summary).toContain("Retry starvation");
    expect(pending[0].memoryRecord!.summary).not.toContain("raw log");
    expect(f.runtime.timeline().find((e) => e.eventId === `multica-activity:${issueId}`)?.memoryRecord).toBeUndefined();
    await f.runtime.flush();
    expect(f.remember).toHaveBeenCalledTimes(1);
    f.outbox.close();
  });

  it("baselines existing handoffs when enabling capture on an existing outbox", async () => {
    const f = fixture();
    f.outbox.initializeActivityBaseline(workspace, issueId, []);
    f.multica.issueActivities = vi.fn(async () => ({ activities: [], handoffs: [handoff], truncated: false }));
    await f.runtime.reconcileActivity();
    await f.runtime.reconcileActivity();
    expect(f.outbox.pendingCount(workspace)).toBe(0);
    f.outbox.close();
  });

  it("rejects arbitrary comments and credential-shaped handoff paragraphs", () => {
    expect(summarizeHandoff({ ...handoff, actor_type: "user" })).toBeUndefined();
    expect(summarizeHandoff({ ...handoff, source_task_id: null })).toBeUndefined();
    expect(summarizeHandoff({ ...handoff, content: "Just discussing ideas without a delivery handoff." })).toBeUndefined();
    expect(summarizeHandoff({ ...handoff, content: handoff.content.replace("180 tests", "api_key=private 180 tests") })).toBeUndefined();
  });

  it("keeps initiative memory if workspace recall fails and audits actual retained IDs", async () => {
    const recall = vi.fn().mockResolvedValueOnce([{ text: JSON.stringify(record) }])
      .mockRejectedValueOnce(new Error("provider secret must not reach audit"));
    const f = fixture(recall);
    const audit = vi.spyOn(f.outbox, "auditRecall");
    const context = await f.runtime.context("image fix");
    expect(context.memory.initiative?.[0].summary).toBe(record.summary);
    expect(context.memory.errors).toEqual({ workspace: "recall_failed" });
    expect(context.resolution.issue.id).toBe(issueId);
    expect(audit).toHaveBeenCalledWith(expect.anything(), "retrieved", expect.objectContaining({
      initiativeIds: ["handoff:fix-images"], workspaceIds: [], metrics: expect.objectContaining({ initiative: expect.objectContaining({ received: 1, valid: 1, retried: false, retained: 1 }) }),
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("provider secret");
    f.outbox.close();
  });

  it("keeps workspace memory if initiative recall fails", async () => {
    const other = { ...record, initiative_id: task, initiative_identifier: "B-181", issue_id: task,
      issue_identifier: "B-181", node_sets: ["initiative:B-181", "type:handoff", "authority:observed"] };
    const f = fixture(vi.fn().mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce([{ text: JSON.stringify(other) }]));
    const context = await f.runtime.context("images");
    expect(context.memory.workspace).toHaveLength(1);
    expect(context.memory.errors).toEqual({ initiative: "recall_failed" });
    f.outbox.close();
  });

  it("fits complete records into the prompt instead of cutting JSON mid-record", () => {
    const items = [{ id: "oversized", summary: "x".repeat(1000) }, { id: "useful", summary: "fix retry ordering" }];
    expect(fitMemories(items, 100)).toEqual([items[1]]);
  });
});
