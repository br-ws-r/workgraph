import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CogneeApiClient } from "../src/cognee.js";
import { MulticaReader } from "../src/multica.js";
import { WorkgraphOutbox } from "../src/outbox.js";
import { createWorkgraphExtension, createWorkgraphOmpExtension } from "../src/pi.js";
import { WorkgraphRuntime } from "../src/runtime.js";

const workspaceId = "00000000-0000-4000-8000-000000000010";
const initiativeId = "00000000-0000-4000-8000-000000000001";
const issue = {
  id: initiativeId, workspace_id: workspaceId, identifier: "B-198",
  title: "Test relay", status: "in_progress", status_category: "in_progress",
  parent_issue_id: null, project_id: null, stage: null,
};

function host(factory: typeof createWorkgraphExtension, path: string, fetch: typeof globalThis.fetch) {
  const multica = new MulticaReader({ run: vi.fn() });
  multica.resolveIssue = vi.fn(async () => ({
    workspace: { id: workspaceId, name: "BRWSR", slug: "brwsr" },
    root: issue, issue, chain: [initiativeId],
  }));
  multica.issueActivities = vi.fn(async () => ({ activities: [], truncated: false }));
  const runtime = new WorkgraphRuntime({
    env: { MULTICA_WORKSPACE_ID: workspaceId }, multica,
    outbox: new WorkgraphOutbox(path),
    cognee: new CogneeApiClient({ serviceUrl: "https://cognee.test", authScheme: "none", fetch }),
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, ToolDefinition>();
  factory({ runtimeFactory: () => runtime })({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerFlag: () => undefined, getFlag: () => "B-198",
  } as unknown as ExtensionAPI);
  const context = { hasUI: false, ui: { setStatus: vi.fn(), notify: vi.fn() } };
  return {
    runtime,
    start: () => handlers.get("session_start")!({}, context),
    call: async (name: string, params: object) => {
      const result = await (tools.get(name)!.execute as any)("call", params, undefined, undefined, context);
      return result.details.value;
    },
  };
}

describe("Pi and OMP delivery contract (real runtime, simulated Cognee HTTP)", () => {
  it.each([
    ["Pi → OMP", createWorkgraphExtension, createWorkgraphOmpExtension],
    ["OMP → Pi", createWorkgraphOmpExtension, createWorkgraphExtension],
  ] as const)("%s writes before settlement and reads across independent outboxes", async (_name, writerFactory, readerFactory) => {
    const directory = mkdtempSync(join(tmpdir(), "workgraph-hosts-"));
    let document = "";
    let complete!: () => void;
    const delivery = new Promise<void>((resolve) => { complete = resolve; });
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      if (String(url).endsWith("remember")) {
        const form = init!.body as FormData;
        expect(form.get("run_in_background")).toBe("false");
        expect(form.getAll("node_set")).toEqual(["initiative:B-198", "type:decision", "authority:confirmed"]);
        document = await (form.get("data") as Blob).text();
        await delivery;
        return Response.json({ status: "completed" });
      }
      return Response.json([{ text: document, source: "graph", kind: "chunk", search_type: "CHUNKS" }]);
    }) as unknown as typeof globalThis.fetch;
    const writer = host(writerFactory, join(directory, "writer.db"), fetch);
    const reader = host(readerFactory, join(directory, "reader.db"), fetch);
    try {
      await writer.start();
      await reader.start();
      const queued = await writer.call("initiative_memory_remember", {
        entity_type: "Decision", authority: "confirmed", entity_identifier: "decision:relay-2",
        summary: "cobalt lantern", source: "multica://issues/B-198",
        relations: [
          { type: "derived_from", target: "decision:relay-1" },
          { type: "observed_in", target: "issue:B-198" },
        ],
      });
      expect(queued).toMatchObject({ event_id: expect.any(String), delivery: "queued" });
      await vi.waitFor(() => expect(document).toContain("cobalt lantern"));
      expect((await writer.call("initiative_timeline", { event_id: queued.event_id }))[0])
        .toMatchObject({ storage: "local_outbox", delivery: { status: "pending" } });
      complete();
      await vi.waitFor(() => expect(writer.runtime.outbox.get(queued.event_id).deliveredAt).toBeTruthy());
      const timeline = await writer.call("initiative_timeline", { event_id: queued.event_id });
      expect(timeline).toHaveLength(1);
      expect(timeline[0]).toMatchObject({ entity_identifier: "decision:relay-2", delivery: { status: "delivered", attempts: 1 } });
      expect(await reader.call("initiative_timeline", { entity_identifier: "decision:relay-2" })).toEqual([]);
      expect(await reader.call("initiative_memory_recall", {
        query: "cobalt lantern", entity_identifier: "decision:relay-2",
      })).toMatchObject({ initiative: [{ entity_identifier: "decision:relay-2", summary: "cobalt lantern" }] });
      const graph = JSON.parse(document.split("\n")[1]);
      expect(graph.nodes).toContainEqual({ identifier: "decision:relay-1", type: "Decision" });
      expect(graph.relations).toContainEqual({ source: "decision:relay-2", type: "derived_from", target: "decision:relay-1" });
      await expect(reader.call("initiative_memory_recall", {
        query: "cobalt", entity_identifier: "decision:relay-2", scope: "workspace",
      })).rejects.toThrow("active initiative scope");
    } finally {
      complete();
      await writer.runtime.shutdown();
      await reader.runtime.shutdown();
    }
  });

  it.each([
    ["Pi → OMP", createWorkgraphExtension, createWorkgraphOmpExtension],
    ["OMP → Pi", createWorkgraphOmpExtension, createWorkgraphExtension],
  ] as const)("%s recovers an interrupted write on startup without new activity", async (_name, firstFactory, nextFactory) => {
    const path = join(mkdtempSync(join(tmpdir(), "workgraph-restart-")), "outbox.db");
    const offline = vi.fn(async () => { throw new Error("connection interrupted"); }) as typeof globalThis.fetch;
    const first = host(firstFactory, path, offline);
    await first.start();
    const queued = await first.call("initiative_memory_remember", {
      entity_type: "Evidence", authority: "observed", summary: "Restart evidence", source: "test://restart",
    });
    await vi.waitFor(() => expect(first.runtime.outbox.get(queued.event_id).deliveryAttempts).toBe(1));
    expect(first.runtime.outbox.get(queued.event_id).deliveredAt).toBeUndefined();
    await first.runtime.shutdown();
    const online = vi.fn(async () => Response.json({ status: "completed" })) as typeof globalThis.fetch;
    const next = host(nextFactory, path, online);
    try {
      await next.start(); // No new event, no explicit write, no settle needed.
      await vi.waitFor(() => expect(next.runtime.outbox.get(queued.event_id).deliveredAt).toBeTruthy());
      expect(online).toHaveBeenCalledOnce();
    } finally {
      await next.runtime.shutdown();
    }
  });
});
