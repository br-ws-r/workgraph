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
const parent = "00000000-0000-4000-8000-000000000012";
const task = "00000000-0000-4000-8000-000000000003";
const run = "00000000-0000-4000-8000-000000000004";

function resolution(overrides: Partial<InitiativeResolution> = {}): InitiativeResolution {
  return {
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
    initiative_id: id,
    initiative_identifier: identifier,
    issue_id: id,
    entity_type: "Decision",
    authority: "confirmed",
    entity_id: `decision:${identifier}`,
    summary: `Decision for ${identifier}.`,
    relations: [],
    node_sets: [`initiative:${identifier}`, "type:decision", "authority:confirmed"],
    source: `multica://issues/${id}`,
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
      initiativeId: initiative,
      initiativeIdentifier: "B-184",
      dataset: `workgraph-workspace-${workspace}`,
      issueId,
    });
    const remembered = await instance.remember({
      entityType: "Decision", entityId: "decision:stable", authority: "confirmed",
      summary: "Keep one stable identity.", source: "test://source",
    });
    expect(remembered.memoryRecord).toMatchObject({
      entity_id: "decision:stable",
      workspace_id: workspace,
      initiative_id: initiative,
      initiative_identifier: "B-184",
      issue_id: issueId,
      node_sets: [
        "initiative:B-184", "type:decision", "authority:confirmed",
        `project:${project}`, `stage:${initiative}-2`,
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
    expect(recall).toHaveBeenNthCalledWith(1, "related decision", `workgraph-workspace-${workspace}`, {
      topK: 8, nodeNames: ["initiative:B-184"], signal: undefined,
    });
    expect(recall).toHaveBeenNthCalledWith(2, "related decision", `workgraph-workspace-${workspace}`, {
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
      project_id: project,
      parent_issue_id: initiative,
      stage: 2,
      node_sets: [
        "initiative:B-184", "type:decision", "authority:confirmed",
        `project:${project}`, `stage:${initiative}-2`,
      ],
    };
    const second = { ...first, entity_id: "decision:B-184:second" };
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
    expect(instance.outbox.path).toBe(join(dataHome, "workgraph", "workgraph-workspace.db"));
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
});
