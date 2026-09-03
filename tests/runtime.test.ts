import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkgraphOutbox } from "../src/outbox.js";
import { WorkgraphRuntime } from "../src/runtime.js";
import { MulticaReader } from "../src/multica.js";

const initiative = "00000000-0000-4000-8000-000000000001";

describe("Workgraph runtime", () => {
  it("keeps No initiative fail-closed for memory", () => {
    const outbox = new WorkgraphOutbox(join(mkdtempSync(join(tmpdir(), "workgraph-")), "outbox.db"));
    const runtime = new WorkgraphRuntime({ outbox, env: {}, multica: new MulticaReader({ run: vi.fn() }) });
    expect(runtime.scope).toBeUndefined();
    expect(() => runtime.remember({
      entityType: "Decision", authority: "confirmed", summary: "No scope.", source: "test://source",
    })).toThrow("No initiative");
    outbox.close();
  });

  it("locks one dataset for the process lifetime", () => {
    const outbox = new WorkgraphOutbox(join(mkdtempSync(join(tmpdir(), "workgraph-")), "outbox.db"));
    const runtime = new WorkgraphRuntime({ outbox, env: {}, multica: new MulticaReader({ run: vi.fn() }) });
    runtime.lockInitiative({ issue: { id: initiative }, root: { id: initiative }, chain: [initiative] });
    expect(runtime.scope?.dataset).toBe(`workgraph-initiative-${initiative}`);
    const remembered = runtime.remember({
      entityType: "Decision", entityId: "decision:stable", authority: "confirmed",
      summary: "Keep one stable identity.", source: "test://source",
    });
    expect(remembered.memoryRecord?.entity_id).toBe("decision:stable");
    expect(() => runtime.lockInitiative({ issue: { id: initiative }, root: { id: initiative }, chain: [initiative] })).toThrow("immutable");
    outbox.close();
  });

  it("uses the exact Multica task as the managed run identity", () => {
    const outbox = new WorkgraphOutbox(join(mkdtempSync(join(tmpdir(), "workgraph-")), "outbox.db"));
    const runtime = new WorkgraphRuntime({
      outbox,
      env: { MULTICA_TASK_ID: "task-1", WORKGRAPH_DATASET_PREFIX: "brwsr-initiative" },
      multica: new MulticaReader({ run: vi.fn() }),
    });
    runtime.lockInitiative({ issue: { id: initiative }, root: { id: initiative }, chain: [initiative] });
    expect(runtime.scope).toMatchObject({
      taskId: "task-1",
      runId: "task-1",
      dataset: `brwsr-initiative-${initiative}`,
    });
    expect(runtime.timeline()[0]).toMatchObject({ taskId: "task-1", runId: "task-1" });
    outbox.close();
  });

  it("prefers a dedicated Multica run identity when supplied", () => {
    const outbox = new WorkgraphOutbox(join(mkdtempSync(join(tmpdir(), "workgraph-")), "outbox.db"));
    const runtime = new WorkgraphRuntime({
      outbox,
      env: { MULTICA_TASK_ID: "task-1", MULTICA_RUN_ID: "run-1" },
      multica: new MulticaReader({ run: vi.fn() }),
    });
    runtime.lockInitiative({ issue: { id: initiative }, root: { id: initiative }, chain: [initiative] });
    expect(runtime.scope).toMatchObject({ taskId: "task-1", runId: "run-1" });
    outbox.close();
  });

  it("uses the user data directory by default", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "workgraph-data-"));
    const runtime = new WorkgraphRuntime({
      env: { XDG_DATA_HOME: dataHome },
      multica: new MulticaReader({ run: vi.fn() }),
    });
    expect(runtime.outbox.path).toBe(join(dataHome, "workgraph", "workgraph.db"));
    runtime.outbox.close();
  });
});
