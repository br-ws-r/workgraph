import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createWorkgraphExtension } from "../src/pi.js";
import type { WorkgraphRuntime } from "../src/runtime.js";

type Handler = (event: any, context: any) => any;

const workspace = "00000000-0000-4000-8000-000000000010";
const initiative = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000002";

function resolution() {
  return {
    issue: {
      id: issueId, workspace_id: workspace, identifier: "B-185", title: "Current issue",
      status: "in_progress", status_category: "in_progress", parent_issue_id: initiative,
      project_id: null, stage: 1,
    },
    root: {
      id: initiative, workspace_id: workspace, identifier: "B-184", title: "Initiative",
      status: "in_progress", status_category: "in_progress", parent_issue_id: null,
      project_id: null, stage: null,
    },
    chain: [issueId, initiative],
  };
}

function capturePi() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => undefined),
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools };
}

function context() {
  const ui = {
    setStatus: vi.fn(), notify: vi.fn(), select: vi.fn(), input: vi.fn(),
  };
  return {
    context: { hasUI: false, signal: new AbortController().signal, ui } as unknown as ExtensionContext,
    ui,
  };
}

function fakeRuntime() {
  const resolved = resolution();
  const runtime = {
    env: { MULTICA_WORKSPACE_ID: workspace },
    scope: {
      workspaceId: workspace, initiativeId: initiative, initiativeIdentifier: "B-184",
      dataset: `workgraph-workspace-${workspace}`, issueId, rootTitle: "Initiative",
    },
    cognee: {},
    multica: { resolveIssue: vi.fn(), resolveTask: vi.fn(), recentRootInitiatives: vi.fn() },
    lockInitiative: vi.fn(),
    context: vi.fn(async () => ({
      resolution: resolved,
      memory: {
        initiative: [{
          workspaceId: workspace, initiativeId: initiative, initiativeIdentifier: "B-184", entityType: "Decision",
          entityId: "decision:1", authority: "confirmed", summary: "Current decision.",
          source: "test://current", observedAt: "2026-09-04T10:00:00.000Z",
        }],
        workspace: [{
          workspaceId: workspace, initiativeId: "00000000-0000-4000-8000-000000000099",
          initiativeIdentifier: "B-100", entityType: "Evidence", entityId: "evidence:1",
          authority: "observed", summary: "Related evidence.", source: "test://history",
          observedAt: "2026-08-01T10:00:00.000Z",
        }],
      },
    })),
    recall: vi.fn(async () => ({ initiative: [] })),
    remember: vi.fn(async () => ({ eventId: "event-1", payloadHash: "hash-1" })),
    settle: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    pendingCount: vi.fn(() => 2),
    timeline: vi.fn(() => []),
    shutdown: vi.fn(async () => undefined),
  };
  return runtime as unknown as WorkgraphRuntime;
}

function install(runtime: WorkgraphRuntime) {
  const harness = capturePi();
  createWorkgraphExtension({ runtimeFactory: () => runtime })(harness.pi);
  return harness;
}

describe("Workgraph Pi extension", () => {
  it("registers the Pi lifecycle and narrow tools", () => {
    const harness = install(fakeRuntime());
    expect([...harness.handlers.keys()]).toEqual([
      "session_start", "before_agent_start", "agent_settled", "session_before_compact", "session_shutdown",
    ]);
    expect([...harness.tools.keys()]).toEqual([
      "initiative_memory_status", "initiative_memory_recall",
      "initiative_memory_remember", "initiative_timeline",
    ]);
  });

  it("automatically injects separated authoritative and memory lanes", async () => {
    const runtime = fakeRuntime();
    const harness = install(runtime);
    const { context: ctx } = context();
    const result = await harness.handlers.get("before_agent_start")!({
      prompt: "What should I do?", systemPrompt: "Base prompt",
    }, ctx);

    expect(runtime.context).toHaveBeenCalledWith("What should I do?", ctx.signal);
    expect(result.systemPrompt).toContain("Base prompt");
    expect(result.systemPrompt).toContain("Authoritative current state");
    expect(result.systemPrompt).toContain("Current decision");
    expect(result.systemPrompt).toContain("Related evidence");
    expect(result.systemPrompt).toContain("B-100");
  });

  it("omits all memory when authoritative refresh fails", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.context).mockRejectedValueOnce(new Error("Multica unavailable"));
    const harness = install(runtime);
    const result = await harness.handlers.get("before_agent_start")!({
      prompt: "Prompt", systemPrompt: "Base",
    }, context().context);

    expect(result.systemPrompt).toContain("memory is omitted");
    expect(result.systemPrompt).not.toContain("Current decision");
  });

  it("retains authoritative context when only Cognee recall fails", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.context).mockResolvedValueOnce({
      resolution: resolution(), memory: {}, memoryError: "Cognee unavailable",
    });
    const harness = install(runtime);
    const result = await harness.handlers.get("before_agent_start")!({
      prompt: "Prompt", systemPrompt: "Base",
    }, context().context);

    expect(result.systemPrompt).toContain("Current issue");
    expect(result.systemPrompt).toContain("Cognee recall unavailable");
  });

  it("automatically settles, compacts, and shuts down", async () => {
    const runtime = fakeRuntime();
    const harness = install(runtime);
    const { context: ctx, ui } = context();

    await harness.handlers.get("agent_settled")!({}, ctx);
    await harness.handlers.get("session_before_compact")!({}, ctx);
    await harness.handlers.get("session_shutdown")!({}, ctx);

    expect(runtime.settle).toHaveBeenCalledOnce();
    expect(runtime.compact).toHaveBeenCalledOnce();
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expect(ui.setStatus).toHaveBeenCalledWith("workgraph", undefined);
  });

  it("forwards constrained recall scope and bounded remember fields", async () => {
    const runtime = fakeRuntime();
    const harness = install(runtime);
    const ctx = context().context;
    const recall = harness.tools.get("initiative_memory_recall")!;
    const remember = harness.tools.get("initiative_memory_remember")!;

    await (recall.execute as any)("call-1", { query: "history", scope: "both", top_k: 5 }, ctx.signal, undefined, ctx);
    const remembered = await (remember.execute as any)("call-2", {
      entity_type: "Decision", authority: "confirmed", entity_id: "decision:1",
      summary: "Use workspace memory.", source: "test://decision",
      relations: [{ type: "about", target: `issue:${initiative}` }],
    }, ctx.signal, undefined, ctx);

    expect(runtime.recall).toHaveBeenCalledWith("history", "both", 5, ctx.signal);
    expect(runtime.remember).toHaveBeenCalledWith({
      entityType: "Decision", authority: "confirmed", entityId: "decision:1",
      summary: "Use workspace memory.", source: "test://decision", sourceRevision: undefined,
      relations: [{ type: "about", target: `issue:${initiative}` }],
    });
    expect(remembered.details.value).toEqual({
      event_id: "event-1", payload_hash: "hash-1", delivery: "queued",
    });
  });
});
