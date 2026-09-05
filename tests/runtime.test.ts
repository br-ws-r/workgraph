import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CogneeApiClient, CogneeRecallEntry } from "../src/cognee.js";
import { MulticaReader, type InitiativeResolution } from "../src/multica.js";
import { WorkgraphOutbox } from "../src/outbox.js";
import { EXTRACTION_PROMPT_VERSION, SCHEMA_VERSION, type MemoryRecord } from "../src/schema.js";
import { WorkgraphRuntime } from "../src/runtime.js";

const workspace = "00000000-0000-4000-8000-000000000010";
const initiative = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000002";
const project = "00000000-0000-4000-8000-000000000011";
const task = "00000000-0000-4000-8000-000000000003";
const run = "00000000-0000-4000-8000-000000000004";
const activityA = "00000000-0000-4000-8000-000000000101";
const activityB = "00000000-0000-4000-8000-000000000102";

function resolution(overrides: Partial<InitiativeResolution> = {}): InitiativeResolution {
  return {
    workspace: { id: workspace, name: "BRWSR", slug: "brwsr" },
    issue: {
      id: issueId, workspace_id: workspace, identifier: "B-185", title: "Current issue",
      status: "in_progress", status_category: "in_progress", parent_issue_id: initiative,
      project_id: project, stage: 2,
    },
    root: {
      id: initiative, workspace_id: workspace, identifier: "B-184", title: "Initiative",
      status: "in_progress", status_category: "in_progress", parent_issue_id: null,
      project_id: project, stage: null,
    },
    parent: {
      id: initiative, workspace_id: workspace, identifier: "B-184", title: "Initiative",
      status: "in_progress", status_category: "in_progress", parent_issue_id: null,
      project_id: project, stage: null,
    },
    project: { id: project, workspace_id: workspace, title: "Devbox" },
    chain: [issueId, initiative],
    ...overrides,
  };
}

function outbox(): WorkgraphOutbox {
  return new WorkgraphOutbox(join(mkdtempSync(join(tmpdir(), "workgraph-")), "outbox.db"));
}

function runtime(options: {
  env?: NodeJS.ProcessEnv;
  cognee?: CogneeApiClient;
  multica?: MulticaReader;
} = {}): WorkgraphRuntime {
  return new WorkgraphRuntime({
    outbox: outbox(),
    env: { MULTICA_WORKSPACE_ID: workspace, ...options.env },
    multica: options.multica ?? new MulticaReader({ run: vi.fn() }),
    cognee: options.cognee,
  });
}

function memory(identifier: string, id: string): MemoryRecord {
  return {
    schema_version: SCHEMA_VERSION,
    extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
    workspace_id: workspace,
    workspace_identifier: "brwsr",
    workspace_name: "BRWSR",
    initiative_id: id,
    initiative_identifier: identifier,
    issue_id: id,
    issue_identifier: identifier,
    entity_type: "Decision",
    authority: "confirmed",
    entity_identifier: `decision:${identifier}`,
    entity_label: `Decision for ${identifier}`,
    summary: `Decision for ${identifier}.`,
    relations: [],
    node_sets: [`initiative:${identifier}`, "type:decision", "authority:confirmed"],
    source: `multica://issues/${identifier}`,
    observed_at: "2026-09-04T09:00:00.000Z",
  };
}

function recallEntry(record: MemoryRecord): CogneeRecallEntry {
  return {
    source: "graph", kind: "chunk", searchType: "CHUNKS",
    text: JSON.stringify(record), metadata: {},
  };
}

describe("Workgraph workspace runtime", () => {
  it("keeps missing initiative fail-closed", async () => {
    const instance = runtime();
    await expect(instance.remember({
      entityType: "Decision", authority: "confirmed", summary: "No scope.", source: "test://source",
    })).rejects.toThrow("No initiative");
    await expect(instance.recall("query")).rejects.toThrow("No initiative");
    instance.outbox.close();
  });

  it("locks one workspace dataset and derives exact record NodeSets", async () => {
    const resolved = resolution();
    const multica = new MulticaReader({ run: vi.fn() });
    multica.resolveIssue = vi.fn(async () => resolved);
    const instance = runtime({ multica });
    instance.lockInitiative(resolved);
    expect(instance.scope).toMatchObject({
      workspaceId: workspace,
      workspaceIdentifier: "brwsr",
      workspaceName: "BRWSR",
      initiativeId: initiative,
      initiativeIdentifier: "B-184",
      dataset: "workgraph-workspace-brwsr",
      issueId,
      issueIdentifier: "B-185",
    });
    const remembered = await instance.remember({
      entityType: "Decision", entityIdentifier: "decision:stable", entityLabel: "Stable decision", authority: "confirmed",
      summary: "Keep one stable identity.", source: "test://source",
    });
    expect(remembered.memoryRecord).toMatchObject({
      entity_identifier: "decision:stable",
      entity_label: "Stable decision",
      workspace_id: workspace,
      workspace_identifier: "brwsr",
      initiative_id: initiative,
      initiative_identifier: "B-184",
      issue_id: issueId,
      issue_identifier: "B-185",
      node_sets: [
        "initiative:B-184", "type:decision", "authority:confirmed",
        "project:devbox-00000000", "stage:B-184-2",
      ],
    });
    expect(multica.resolveIssue).toHaveBeenCalledOnce();
    expect(() => instance.lockInitiative(resolved)).toThrow("immutable");
    instance.outbox.close();
  });

  it("rejects workspace mismatches and missing root identifiers", () => {
    const instance = runtime();
    expect(() => instance.lockInitiative(resolution({
      root: { ...resolution().root, workspace_id: "00000000-0000-4000-8000-000000000020" },
    }))).toThrow("configured workspace");
    const second = runtime();
    expect(() => second.lockInitiative(resolution({
      root: { ...resolution().root, identifier: "" },
    }))).toThrow("root identifier");
    instance.outbox.close();
    second.outbox.close();
  });

  it("uses exact managed task and dedicated run identities", () => {
    const fallback = runtime();
    fallback.lockInitiative(resolution({ taskId: task }));
    expect(fallback.scope).toMatchObject({ taskId: task, runId: task });
    expect(fallback.timeline()[0]).toMatchObject({ taskId: task, runId: task });
    fallback.outbox.close();

    const dedicated = runtime({ env: { MULTICA_RUN_ID: run } });
    dedicated.lockInitiative(resolution({ taskId: task }));
    expect(dedicated.scope).toMatchObject({ taskId: task, runId: run });
    dedicated.outbox.close();
  });

  it("refreshes managed task assignment before writing", async () => {
    const resolved = resolution({ taskId: task });
    const multica = new MulticaReader({ run: vi.fn() });
    multica.resolveTask = vi.fn(async () => resolved);
    const instance = runtime({ env: { MULTICA_AGENT_ID: initiative }, multica });
    instance.lockInitiative(resolved);

    await instance.remember({
      entityType: "Decision", authority: "confirmed", summary: "Still assigned.", source: "test://source",
    });

    expect(multica.resolveTask).toHaveBeenCalledWith(task, initiative, workspace);
    await instance.shutdown();
  });

  it("refreshes authority and returns separated initiative and workspace lanes", async () => {
    const resolved = resolution();
    const historicalId = "00000000-0000-4000-8000-000000000099";
    const recall = vi.fn(async (_query: string, _dataset: string, options: { nodeNames?: string[] }) =>
      options.nodeNames?.length
        ? [recallEntry(memory("B-184", initiative)), recallEntry(memory("B-999", initiative))]
        : [recallEntry(memory("B-184", initiative)), recallEntry(memory("B-100", historicalId))]);
    const multica = new MulticaReader({ run: async () => { throw new Error("unused"); } });
    multica.resolveIssue = vi.fn(async () => resolved);
    const instance = runtime({ cognee: { recall, remember: vi.fn() } as unknown as CogneeApiClient, multica });
    instance.lockInitiative(resolved);

    const context = await instance.context("related decision");

    expect(context.memory.initiative?.map((item) => item.initiativeIdentifier)).toEqual(["B-184"]);
    expect(context.memory.workspace?.map((item) => item.initiativeIdentifier)).toEqual(["B-100"]);
    expect(recall).toHaveBeenNthCalledWith(1, "related decision", "workgraph-workspace-brwsr", {
      topK: 8, nodeNames: ["initiative:B-184"], signal: undefined,
    });
    expect(recall).toHaveBeenNthCalledWith(2, "related decision", "workgraph-workspace-brwsr", {
      topK: 20, signal: undefined,
    });
    instance.outbox.close();
  });

  it("fails closed when refreshed Multica changes the root", async () => {
    const changed = resolution({
      root: { ...resolution().root, id: "00000000-0000-4000-8000-000000000099", identifier: "B-999" },
    });
    const multica = new MulticaReader({ run: vi.fn() });
    multica.resolveIssue = vi.fn(async () => changed);
    const instance = runtime({ multica });
    instance.lockInitiative(resolution());
    await expect(instance.context("query")).rejects.toThrow("root changed");
    instance.outbox.close();
  });

  it("fails closed when refreshed Multica changes the locked issue identity", async () => {
    const changed = resolution({
      issue: { ...resolution().issue, identifier: "B-999" },
    });
    const multica = new MulticaReader({ run: vi.fn() });
    multica.resolveIssue = vi.fn(async () => changed);
    const instance = runtime({ multica });
    instance.lockInitiative(resolution());
    await expect(instance.context("query")).rejects.toThrow("scope changed");
    instance.outbox.close();
  });

  it("fails closed when a real Multica refresh changes the workspace slug", async () => {
    const resolved = resolution();
    let workspaceReads = 0;
    const multica = new MulticaReader({ run: async (_command, args) => {
      if (args[0] === "workspace") {
        workspaceReads += 1;
        return { ...resolved.workspace, slug: workspaceReads === 1 ? "brwsr" : "brwsr-renamed" };
      }
      if (args.includes("project")) return resolved.project!;
      const requested = args[args.indexOf("get") + 1];
      return requested === issueId ? resolved.issue : resolved.root;
    } });
    const instance = runtime({ multica });
    instance.lockInitiative(await multica.resolveIssue(issueId, workspace));

    await expect(instance.context("query")).rejects.toThrow("scope changed");
    instance.outbox.close();
  });

  it("preserves fresh Multica context when Cognee recall fails", async () => {
    const resolved = resolution();
    const multica = new MulticaReader({ run: vi.fn() });
    multica.resolveIssue = vi.fn(async () => resolved);
    const cognee = {
      recall: vi.fn(async () => { throw new Error("Cognee unavailable"); }), remember: vi.fn(),
    } as unknown as CogneeApiClient;
    const instance = runtime({ multica, cognee });
    instance.lockInitiative(resolved);

    const context = await instance.context("query");

    expect(context.resolution).toBe(resolved);
    expect(context.memory).toEqual({});
    expect(context.memoryError).toContain("Cognee unavailable");
    instance.outbox.close();
  });

  it("does not derive a stage NodeSet for a root issue", () => {
    const rootResolution = resolution({
      issue: { ...resolution().root, stage: 1 },
      parent: undefined,
      chain: [initiative],
    });
    const instance = runtime();
    instance.lockInitiative(rootResolution);
    expect(instance.timeline()[0].nodeSets.some((value) => value.startsWith("stage:"))).toBe(false);
    instance.outbox.close();
  });

  it("flushes workspace records and retains failed writes", async () => {
    const remember = vi.fn()
      .mockResolvedValueOnce({ status: "completed" })
      .mockRejectedValueOnce(new Error("offline"));
    const cognee = { recall: vi.fn(), remember } as unknown as CogneeApiClient;
    const instance = runtime({ cognee });
    const resolved = resolution();
    instance.lockInitiative(resolved);
    const first: MemoryRecord = {
      ...memory("B-184", initiative),
      issue_id: issueId,
      issue_identifier: "B-185",
      project_id: project,
      project_identifier: "devbox-00000000",
      parent_issue_id: initiative,
      parent_issue_identifier: "B-184",
      stage: 2,
      node_sets: [
        "initiative:B-184", "type:decision", "authority:confirmed",
        "project:devbox-00000000", "stage:B-184-2",
      ],
    };
    const second = { ...first, entity_identifier: "decision:B-184:second" };
    instance.append("decision_recorded", first.summary, first.source, first.authority, first);
    instance.append("decision_recorded", second.summary, second.source, second.authority, second);

    const result = await instance.flush(25, 3000);

    expect(result).toEqual({ delivered: 1, failed: 1 });
    expect(instance.pendingCount()).toBe(1);
    instance.outbox.close();
  });

  it("uses a separate workspace database by default", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "workgraph-data-"));
    const instance = new WorkgraphRuntime({
      env: { XDG_DATA_HOME: dataHome },
      multica: new MulticaReader({ run: vi.fn() }),
    });
    expect(instance.outbox.path).toBe(join(dataHome, "workgraph", "workgraph-workspace-v3.db"));
    instance.outbox.close();
  });

  it("makes shutdown terminal for the serialized delivery queue", async () => {
    const instance = runtime();
    instance.lockInitiative(resolution());

    const shutdown = instance.shutdown();
    await expect(instance.flush()).resolves.toEqual({ delivered: 0, failed: 0 });
    await expect(shutdown).resolves.toBeUndefined();
    await expect(instance.shutdown()).resolves.toBeUndefined();
  });

  it("baselines existing Multica activity and captures each new server event once", async () => {
    const resolved = resolution();
    const first = {
      id: activityA, type: "activity" as const, action: "created", actor_id: initiative, actor_type: "member",
      created_at: "2026-09-04T10:00:00Z", details: {},
    };
    const second = {
      id: activityB, type: "activity" as const, action: "status_changed", actor_id: "", actor_type: "system",
      created_at: "2026-09-04T10:00:01Z",
      details: { from: "in_progress", to: "done", unrestricted: "must not be copied" },
    };
    const multica = new MulticaReader({ run: vi.fn() });
    multica.resolveIssue = vi.fn(async () => resolved);
    multica.issueActivities = vi.fn()
      .mockResolvedValueOnce({ activities: [first], truncated: false })
      .mockResolvedValue({ activities: [first, second], truncated: false });
    const instance = runtime({ multica });
    instance.lockInitiative(resolved);

    await expect(instance.reconcileActivity()).resolves.toBe(0);
    await expect(instance.reconcileActivity()).resolves.toBe(1);
    await expect(instance.reconcileActivity()).resolves.toBe(0);

    const captured = instance.timeline().filter((event) => event.eventId === `multica-activity:${activityB}`);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      timestamp: second.created_at,
      source: "multica://issues/B-185/activity",
      sourceRevision: activityB,
      boundedSummary: "Multica issue B-185: Status changed from in_progress to done. Actor type: system.",
      authority: "observed",
    });
    expect(captured[0].boundedSummary).not.toContain("must not be copied");
    expect(captured[0].memoryRecord).toMatchObject({
      entity_identifier: expect.stringMatching(/^evidence-status-changed:B-185:20260904T100001Z:[a-f0-9]{10}$/),
      entity_label: "B-185 status changed",
      observed_at: second.created_at,
    });
    instance.outbox.close();
  });

  it("does not advance past a truncated timeline that lost the stored cursor", async () => {
    const resolved = resolution();
    const first = {
      id: activityA, type: "activity" as const, action: "created", actor_id: "", actor_type: "system",
      created_at: "2026-09-04T10:00:00Z", details: {},
    };
    const later = {
      id: activityB, type: "activity" as const, action: "task_completed", actor_id: "", actor_type: "system",
      created_at: "2026-09-04T10:00:02Z", details: {},
    };
    const multica = new MulticaReader({ run: vi.fn() });
    multica.resolveIssue = vi.fn(async () => resolved);
    multica.issueActivities = vi.fn()
      .mockResolvedValueOnce({ activities: [first], truncated: false })
      .mockResolvedValueOnce({ activities: [later], truncated: true });
    const instance = runtime({ multica });
    instance.lockInitiative(resolved);
    await instance.reconcileActivity();

    await expect(instance.reconcileActivity()).rejects.toThrow("truncated without overlap");
    expect(instance.outbox.hasSeenActivity(workspace, issueId, activityA)).toBe(true);
    expect(instance.outbox.hasSeenActivity(workspace, issueId, activityB)).toBe(false);
    expect(instance.timeline().some((event) => event.eventId === `multica-activity:${activityB}`)).toBe(false);
    instance.outbox.close();
  });

  it("does not lose a new activity with the same second and a smaller UUID", async () => {
    const resolved = resolution();
    const largerId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const smallerId = "00000000-0000-4000-8000-000000000100";
    const baseline = {
      id: largerId, type: "activity" as const, action: "created", actor_id: "", actor_type: "system",
      created_at: "2026-09-04T10:00:00Z", details: {},
    };
    const next = {
      id: smallerId, type: "activity" as const, action: "status_changed", actor_id: "", actor_type: "system",
      created_at: "2026-09-04T10:00:00Z", details: { from: "backlog", to: "in_progress" },
    };
    const multica = new MulticaReader({ run: vi.fn() });
    multica.resolveIssue = vi.fn(async () => resolved);
    multica.issueActivities = vi.fn()
      .mockResolvedValueOnce({ activities: [baseline], truncated: false })
      .mockResolvedValueOnce({ activities: [baseline, next], truncated: false });
    const instance = runtime({ multica });
    instance.lockInitiative(resolved);
    await instance.reconcileActivity();

    await expect(instance.reconcileActivity()).resolves.toBe(1);
    expect(instance.timeline().some((event) => event.eventId === `multica-activity:${smallerId}`)).toBe(true);
    instance.outbox.close();
  });

  it("fails closed when an empty baseline has no overlap with a later truncated window", async () => {
    const resolved = resolution();
    const multica = new MulticaReader({ run: vi.fn() });
    multica.resolveIssue = vi.fn(async () => resolved);
    multica.issueActivities = vi.fn()
      .mockResolvedValueOnce({ activities: [], truncated: false })
      .mockResolvedValueOnce({ activities: [{
        id: activityA, type: "activity", action: "created", actor_id: "", actor_type: "system",
        created_at: "2026-09-04T10:00:00Z", details: {},
      }], truncated: true });
    const instance = runtime({ multica });
    instance.lockInitiative(resolved);
    await instance.reconcileActivity();

    await expect(instance.reconcileActivity()).rejects.toThrow("truncated without overlap");
    expect(instance.outbox.hasSeenActivity(workspace, issueId, activityA)).toBe(false);
    instance.outbox.close();
  });

  it("does not silently re-baseline after startup reconciliation fails", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "workgraph-failed-baseline-")), "outbox.db");
    const resolved = resolution();
    const multica = new MulticaReader({ run: vi.fn() });
    multica.resolveIssue = vi.fn(async () => resolved);
    multica.issueActivities = vi.fn()
      .mockRejectedValueOnce(new Error("Multica unavailable"))
      .mockResolvedValueOnce({ activities: [{
        id: activityA, type: "activity", action: "created", actor_id: "", actor_type: "system",
        created_at: "2026-09-04T10:00:00Z", details: {},
      }], truncated: false });
    const instance = new WorkgraphRuntime({
      outbox: new WorkgraphOutbox(path), env: { MULTICA_WORKSPACE_ID: workspace }, multica,
    });
    instance.lockInitiative(resolved);

    await expect(instance.reconcileActivity()).rejects.toThrow("Multica unavailable");
    await expect(instance.reconcileActivity()).rejects.toThrow("operator recovery");
    expect(instance.outbox.hasActivityBaseline(workspace, issueId)).toBe(false);
    instance.outbox.close();

    const restarted = new WorkgraphRuntime({
      outbox: new WorkgraphOutbox(path), env: { MULTICA_WORKSPACE_ID: workspace }, multica,
    });
    restarted.lockInitiative(resolved);
    await expect(restarted.reconcileActivity()).rejects.toThrow("operator recovery");
    restarted.outbox.close();
  });

  it("does not import a stale snapshot when another process wins baseline initialization", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "workgraph-race-")), "outbox.db");
    const resolved = resolution();
    let releaseStale!: (value: { activities: any[]; truncated: boolean }) => void;
    const staleRead = new Promise<{ activities: any[]; truncated: boolean }>((resolve) => { releaseStale = resolve; });
    const staleMultica = new MulticaReader({ run: vi.fn() });
    staleMultica.resolveIssue = vi.fn(async () => resolved);
    staleMultica.issueActivities = vi.fn(async () => staleRead);
    const currentMultica = new MulticaReader({ run: vi.fn() });
    currentMultica.resolveIssue = vi.fn(async () => resolved);
    currentMultica.issueActivities = vi.fn(async () => ({ activities: [{
      id: activityB, type: "activity" as const, action: "status_changed", actor_id: "", actor_type: "system",
      created_at: "2026-09-04T10:00:01Z", details: { from: "backlog", to: "in_progress" },
    }], truncated: true }));
    const stale = new WorkgraphRuntime({
      outbox: new WorkgraphOutbox(path), env: { MULTICA_WORKSPACE_ID: workspace }, multica: staleMultica,
    });
    const current = new WorkgraphRuntime({
      outbox: new WorkgraphOutbox(path), env: { MULTICA_WORKSPACE_ID: workspace }, multica: currentMultica,
    });
    stale.lockInitiative(resolved);
    current.lockInitiative(resolved);

    const staleOperation = stale.reconcileActivity();
    await current.reconcileActivity();
    releaseStale({ activities: [{
      id: activityA, type: "activity", action: "created", actor_id: "", actor_type: "system",
      created_at: "2026-09-04T10:00:00Z", details: {},
    }], truncated: true });
    await expect(staleOperation).resolves.toBe(0);

    expect(stale.timeline().some((event) => event.eventId === `multica-activity:${activityA}`)).toBe(false);
    stale.outbox.close();
    current.outbox.close();
  });

  it("drains more than one delivery batch before shutdown closes SQLite", async () => {
    const resolved = resolution();
    const remember = vi.fn(async () => ({ status: "completed" }));
    const multica = new MulticaReader({ run: vi.fn() });
    multica.resolveIssue = vi.fn(async () => resolved);
    multica.issueActivities = vi.fn(async () => ({ activities: [], truncated: false }));
    const instance = runtime({ multica, cognee: { recall: vi.fn(), remember } as unknown as CogneeApiClient });
    instance.lockInitiative(resolved);
    instance.outbox.initializeActivityBaseline(workspace, issueId, []);
    for (let index = 0; index < 30; index += 1) {
      const record: MemoryRecord = {
        ...memory("B-184", initiative),
        issue_id: issueId,
        issue_identifier: "B-185",
        project_id: project,
        project_identifier: "devbox-00000000",
        parent_issue_id: initiative,
        parent_issue_identifier: "B-184",
        stage: 2,
        entity_identifier: `decision:shutdown:${index}`,
        node_sets: [
          "initiative:B-184", "type:decision", "authority:confirmed",
          "project:devbox-00000000", "stage:B-184-2",
        ],
      };
      instance.append("decision_recorded", record.summary, record.source, record.authority, record);
    }

    await instance.shutdown();

    expect(remember).toHaveBeenCalledTimes(30);
  });
});
