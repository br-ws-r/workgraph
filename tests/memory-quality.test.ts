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
    f.runtime.auditInjected(["handoff:fix-images"], [], context.memory);
    expect(audit.mock.calls[1][2]).toMatchObject({
      recallId: (audit.mock.calls[0][2] as { recallId: string }).recallId,
      initiativeIds: ["handoff:fix-images"], workspaceIds: [],
    });
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

describe("B-226 handoff regression", () => {
  it.each(["IN PROGRESS —", "BLOCKED –", "DONE:", "Merged.", "NEEDS DECISION —", "Decision resolved —", "**IN PROGRESS** —"])(
    "captures the authored prefix %s with source and pending acceptance intact", (prefix) => {
      const content = `${prefix} PR #168 merged; deployment and /srv/data/activegraph deletion remain pending.\n\nPrivate attachment and full transcript excluded.`;
      const summary = summarizeHandoff({ ...handoff, content });
      expect(summary).toContain("deletion remain pending");
      expect(summary).not.toContain("Private attachment");
    });
  it("repairs already-seen comments idempotently and exposes rejection counts", async () => {
    const f = fixture();
    const rejected = { ...handoff, id: issueId, content: "Ordinary discussion, not a delivery handoff." };
    const merged = { ...handoff, content: "Merged. PR #168 merged; deployment and data deletion remain pending verification." };
    f.multica.issueActivities = vi.fn(async () => ({ activities: [], handoffs: [merged, rejected], truncated: false }));
    await f.runtime.reconcileActivity(); // Existing comments were baselined by the old path.
    expect(f.outbox.pendingCount(workspace)).toBe(0);
    expect(await f.runtime.repairHandoffs("2026-09-08T00:00:00Z")).toBe(1);
    expect(await f.runtime.repairHandoffs("2026-09-08T00:00:00Z")).toBe(0);
    expect(f.outbox.pending(workspace)[0].memoryRecord).toMatchObject({ source_revision: task,
      summary: merged.content, relations: [{ type: "about", target: "issue:B-225" }] });
    expect(f.outbox.handoffCapture(workspace, issueId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "accepted", count: 1 }), expect.objectContaining({ reason: "unsupported_format", count: 1 }),
    ]));
    f.multica.issueActivities = vi.fn(async () => ({ activities: [], handoffs: [merged], truncated: true }));
    await expect(f.runtime.repairHandoffs("2026-09-08T00:00:00Z")).rejects.toThrow("truncated");
    f.outbox.close();
  });
  it("records explicit parent edges and fresh child states without requiring Cognee recall", async () => {
    const f = fixture();
    f.multica.children = vi.fn(async () => [{ ...issue, id: task, identifier: "B-226", parent_issue_id: issueId }]);
    const state = await f.runtime.deliveryContext();
    expect(state.children).toEqual([{ identifier: "B-226", status: "in_progress", status_category: undefined }]);
    await f.runtime.deliveryContext();
    const snapshots = f.outbox.pending(workspace).filter((e) => e.memoryRecord?.entity_type === "Issue");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].memoryRecord?.relations).toContainEqual({ type: "part_of", target: "initiative:B-225" });
    f.outbox.close();
  });
});

it("B-226 emits child_of B-150 and durably registers the parent continuation", async () => {
  const parent = { ...issue, identifier: "B-150", assignee_type: "agent", assignee_id: task };
  const child = { ...issue, id: task, identifier: "B-226", parent_issue_id: issueId };
  const scope = { ...resolution, issue: child, root: parent, parent, chain: [task, issueId] };
  const multica = new MulticaReader({ run: vi.fn() });
  multica.resolveIssue = vi.fn(async () => scope);
  multica.children = vi.fn(async () => []);
  const outbox = new WorkgraphOutbox(join(mkdtempSync(join(tmpdir(), "child-state-")), "outbox.db"));
  const runtime = new WorkgraphRuntime({ env: {}, multica, outbox }); // No Cognee dependency.
  runtime.lockInitiative(scope);
  await runtime.deliveryContext();
  const snapshot = outbox.pending(workspace).find((event) => event.memoryRecord?.entity_type === "Issue");
  expect(snapshot?.memoryRecord).toMatchObject({ entity_identifier: "issue:B-226", initiative_identifier: "B-150",
    relations: [{ type: "part_of", target: "initiative:B-150" }, { type: "child_of", target: "issue:B-150" }] });
  const { FollowupStore } = await import("../src/followups.js");
  const store = new FollowupStore(`${outbox.path}.followups.db`);
  expect(store.list(workspace)[0]).toMatchObject({ ownerIdentifier: "B-150", status: "waiting",
    condition: { kind: "issue_terminal", issueId: task } });
  expect(store.executorStatus(workspace).recentlyObserved).toBe(false);
  store.close(); await runtime.shutdown();
});
