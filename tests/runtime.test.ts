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
    expect(runtime.scope?.dataset).toBe(`brwsr-initiative-${initiative}`);
    expect(() => runtime.lockInitiative({ issue: { id: initiative }, root: { id: initiative }, chain: [initiative] })).toThrow("immutable");
    outbox.close();
  });
});
