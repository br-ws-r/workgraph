import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createWorkgraphExtension } from "../src/pi.js";
import type { WorkgraphRuntime } from "../src/runtime.js";

type Handler = (event: any, context: any) => any;

const workspace = "00000000-0000-4000-8000-000000000010";
const initiative = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000002";
const project = "00000000-0000-4000-8000-000000000011";

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
    workspace: { id: workspace, name: "BRWSR", slug: "brwsr", issue_prefix: "B" },
    parent: {
      id: initiative, workspace_id: workspace, identifier: "B-184", title: "Initiative",
      status: "in_progress", status_category: "in_progress", parent_issue_id: null,
      project_id: null, stage: null,
    },
    project: undefined,
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
      workspaceId: workspace, workspaceIdentifier: "brwsr", workspaceName: "BRWSR",
      initiativeId: initiative, initiativeIdentifier: "B-184",
      dataset: "workgraph-workspace-brwsr", issueId, issueIdentifier: "B-185", rootTitle: "Initiative",
    },
    cognee: {},
    multica: {
      workspace: vi.fn(async () => resolved.workspace),
      isCurrentChat: vi.fn(async () => false),
      project: vi.fn(),
      resolveIssue: vi.fn(), resolveTask: vi.fn(), recentRootInitiatives: vi.fn(),
    },
    lockInitiative: vi.fn(),
    context: vi.fn(async () => ({
      resolution: resolved,
      memory: {
        initiative: [{
          workspaceId: workspace, initiativeId: initiative, initiativeIdentifier: "B-184", entityType: "Decision",
          entityIdentifier: "decision:1", entityLabel: "Current decision", authority: "confirmed", summary: "Current decision.",
          source: "test://current", observedAt: "2026-09-04T10:00:00.000Z",
        }],
        workspace: [{
          workspaceId: workspace, initiativeId: "00000000-0000-4000-8000-000000000099",
          initiativeIdentifier: "B-100", entityType: "Evidence",
          entityIdentifier: "evidence:1", entityLabel: "Related evidence",
          authority: "observed", summary: "Related evidence.", source: "test://history",
          observedAt: "2026-08-01T10:00:00.000Z",
        }],
      },
    })),
    workspaceContext: vi.fn(async () => ({
      workspace: resolved.workspace,
      memory: [{
        workspaceId: workspace, initiativeId: initiative, initiativeIdentifier: "B-184", entityType: "Decision",
        entityIdentifier: "decision:workspace", entityLabel: "Workspace decision", authority: "confirmed",
        summary: "Workspace decision.", source: "test://workspace", observedAt: "2026-09-04T10:00:00.000Z",
      }],
    })),
    recall: vi.fn(async () => ({ initiative: [] })),
    remember: vi.fn(async () => ({
      eventId: "event-1", payloadHash: "hash-1",
      memoryRecord: { entity_identifier: "decision:workspace-memory" },
    })),
    reconcileActivity: vi.fn(async () => 0),
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
    expect(result.systemPrompt).toContain('"issue_identifier":"B-185"');
    expect(result.systemPrompt).toContain('"initiative_identifier":"B-184"');
    expect(result.systemPrompt).not.toContain(issueId);
    expect(result.systemPrompt).toContain("Current decision");
    expect(result.systemPrompt).toContain("Related evidence");
    expect(result.systemPrompt).toContain("B-100");
    expect(result.systemPrompt).not.toContain(workspace);
    expect(result.systemPrompt).not.toContain(initiative);
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

  it("offers read-only workspace memory on demand in a verified chat", async () => {
    const runtime = fakeRuntime();
    (runtime as any).scope = undefined;
    runtime.env.MULTICA_TASK_ID = "00000000-0000-4000-8000-000000000003";
    runtime.env.MULTICA_AGENT_ID = "00000000-0000-4000-8000-000000000004";
    vi.mocked(runtime.multica.isCurrentChat).mockResolvedValueOnce(true);
    const harness = install(runtime);
    const { context: ctx, ui } = context();

    await harness.handlers.get("session_start")!({}, ctx);

    const prompt = await harness.handlers.get("before_agent_start")!({
      prompt: "What is the OMP status?", systemPrompt: "Base",
    }, ctx);
    const recall = harness.tools.get("initiative_memory_recall")!;
    const recalled = await (recall.execute as any)(
      "call-workspace", { query: "OMP", top_k: 4 }, ctx.signal, undefined, ctx,
    );

    expect(runtime.workspaceContext).toHaveBeenCalledOnce();
    expect(runtime.workspaceContext).toHaveBeenCalledWith("OMP", 4, ctx.signal);
    expect(prompt.systemPrompt).toContain("available on demand");
    expect(prompt.systemPrompt).not.toContain("Workspace decision");
    expect(prompt.systemPrompt).toContain("No initiative is selected");
    expect(recalled.details.value.workspace).toHaveLength(1);
    expect(runtime.remember).not.toHaveBeenCalled();
    expect(ui.setStatus).toHaveBeenCalledWith("workgraph", "Workgraph: workspace chat");

    const status = harness.tools.get("initiative_memory_status")!;
    const statusResult = await (status.execute as any)("call-status", {}, undefined, undefined, ctx);
    expect(statusResult.details.value.mode).toBe("workspace-chat");
  });

  it("does not recall workspace memory for a generic unscoped session", async () => {
    const runtime = fakeRuntime();
    (runtime as any).scope = undefined;
    const harness = install(runtime);

    const prompt = await harness.handlers.get("before_agent_start")!({
      prompt: "Prompt", systemPrompt: "Base",
    }, context().context);

    expect(prompt).toBeUndefined();
    expect(runtime.workspaceContext).not.toHaveBeenCalled();
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

  it("establishes the Multica activity baseline after locking the initiative", async () => {
    const runtime = fakeRuntime();
    runtime.env.MULTICA_ISSUE_ID = issueId;
    vi.mocked(runtime.multica.resolveIssue).mockResolvedValueOnce(resolution());
    vi.mocked(runtime.lockInitiative).mockReturnValueOnce(runtime.scope!);
    const harness = install(runtime);
    const { context: ctx } = context();

    await harness.handlers.get("session_start")!({}, ctx);

    expect(runtime.lockInitiative).toHaveBeenCalledOnce();
    expect(runtime.reconcileActivity).toHaveBeenCalledOnce();
  });

  it("offers three recent initiatives by readable ID and accepts an ID manually", async () => {
    const runtime = fakeRuntime();
    delete runtime.env.MULTICA_WORKSPACE_ID;
    const roots = ["B-201", "B-200", "B-184"].map((identifier, index) => ({
      ...resolution().root,
      id: `00000000-0000-4000-8000-${String(201 - index).padStart(12, "0")}`,
      identifier,
      title: `Initiative ${identifier}`,
      project_id: index < 2 ? project : null,
    }));
    vi.mocked(runtime.multica.recentRootInitiatives).mockResolvedValueOnce(roots);
    vi.mocked(runtime.multica.project).mockResolvedValue({
      id: project, workspace_id: workspace, title: "Devbox Platform",
    });
    vi.mocked(runtime.multica.resolveIssue).mockResolvedValueOnce(resolution());
    vi.mocked(runtime.lockInitiative).mockReturnValueOnce(runtime.scope!);
    const harness = install(runtime);
    const { context: ctx, ui } = context();
    (ctx as any).hasUI = true;
    ui.select.mockResolvedValueOnce("Enter initiative ID (XYZ-123)");
    ui.input.mockResolvedValueOnce("B-184");

    await harness.handlers.get("session_start")!({}, ctx);

    expect(runtime.multica.workspace).toHaveBeenCalledOnce();
    expect(runtime.multica.recentRootInitiatives).toHaveBeenCalledWith(workspace, 3);
    expect(runtime.multica.project).toHaveBeenCalledOnce();
    expect(ui.select).toHaveBeenCalledWith("Select initiative", [
      "B-201 [devbox-platform] - Initiative B-201 [in_progress]",
      "B-200 [devbox-platform] - Initiative B-200 [in_progress]",
      "B-184 - Initiative B-184 [in_progress]",
      "Enter initiative ID (XYZ-123)",
      "No initiative",
    ]);
    expect(ui.input).toHaveBeenCalledWith("Initiative ID (XYZ-123)");
    expect(runtime.multica.resolveIssue).toHaveBeenCalledWith("B-184", workspace);
  });

  it("forwards constrained recall scope and bounded remember fields", async () => {
    const runtime = fakeRuntime();
    const harness = install(runtime);
    const ctx = context().context;
    const recall = harness.tools.get("initiative_memory_recall")!;
    const remember = harness.tools.get("initiative_memory_remember")!;

    await (recall.execute as any)("call-1", { query: "history", scope: "both", top_k: 5 }, ctx.signal, undefined, ctx);
    const remembered = await (remember.execute as any)("call-2", {
      entity_type: "Decision", authority: "confirmed", entity_identifier: "decision:workspace-memory",
      entity_label: "Workspace memory decision",
      summary: "Use workspace memory.", source: "test://decision",
      relations: [{ type: "about", target: "issue:B-184" }],
    }, ctx.signal, undefined, ctx);

    expect(runtime.recall).toHaveBeenCalledWith("history", "both", 5, ctx.signal);
    expect(runtime.remember).toHaveBeenCalledWith({
      entityType: "Decision", authority: "confirmed", entityIdentifier: "decision:workspace-memory",
      entityLabel: "Workspace memory decision",
      summary: "Use workspace memory.", source: "test://decision", sourceRevision: undefined,
      relations: [{ type: "about", target: "issue:B-184" }],
    });
    expect(remembered.details.value).toEqual({
      entity_identifier: "decision:workspace-memory", delivery: "queued",
    });
  });

  it("keeps internal issue UUIDs out of the status tool response", async () => {
    const runtime = fakeRuntime();
    const harness = install(runtime);
    const status = harness.tools.get("initiative_memory_status")!;

    const response = await (status.execute as any)("call-status", {}, undefined, undefined, context().context);

    expect(response.details.value.scope).toMatchObject({
      initiativeIdentifier: "B-184",
      issueIdentifier: "B-185",
    });
    expect(response.details.value).toMatchObject({ pending_deliveries: 2 });
    expect(response.details.value).not.toHaveProperty("pending");
    expect(response.content[0].text).not.toContain(issueId);
  });

  it("reports each timeline event with its originating issue identifier", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.timeline).mockReturnValueOnce([{
      timestamp: "2026-09-04T10:00:00.000Z",
      eventType: "evidence_recorded",
      issueIdentifier: "B-999",
      initiativeIdentifier: "B-184",
      boundedSummary: "Historical event.",
      source: "multica://issues/B-999",
      authority: "observed",
      nodeSets: [],
    } as any]);
    const timeline = install(runtime).tools.get("initiative_timeline")!;

    const response = await (timeline.execute as any)("call-timeline", {}, undefined, undefined, context().context);

    expect(response.details.value[0].issue_identifier).toBe("B-999");
  });
});
