import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkgraphOmpExtension } from "../src/pi.js";
import type { WorkgraphRuntime } from "../src/runtime.js";

type Handler = (event: any, context: any) => any;

const workspace = "00000000-0000-4000-8000-000000000010";
const task = "00000000-0000-4000-8000-000000000020";
const agent = "00000000-0000-4000-8000-000000000030";

function resolution() {
  const root = {
    id: "00000000-0000-4000-8000-000000000001",
    workspace_id: workspace,
    identifier: "B-195",
    title: "OMP compatibility",
    status: "in_progress",
    status_category: "in_progress",
    parent_issue_id: null,
    project_id: null,
    stage: null,
  };
  return {
    issue: root,
    root,
    workspace: { id: workspace, name: "BRWSR", slug: "brwsr", issue_prefix: "B" },
    chain: [root.id],
  };
}

function fakeRuntime(env: NodeJS.ProcessEnv = {}) {
  const resolved = resolution();
  const runtime = {
    env,
    scope: undefined,
    cognee: {},
    multica: {
      workspace: vi.fn(async () => resolved.workspace),
      isCurrentChat: vi.fn(async () => false),
      project: vi.fn(),
      resolveIssue: vi.fn(async () => resolved),
      resolveTask: vi.fn(async () => ({ ...resolved, taskId: task })),
      recentRootInitiatives: vi.fn(async () => [resolved.root]),
    },
    lockInitiative: vi.fn(() => ({
      workspaceIdentifier: "brwsr",
      initiativeIdentifier: "B-195",
      issueIdentifier: "B-195",
      rootTitle: "OMP compatibility",
    })),
    context: vi.fn(async () => ({ resolution: resolved, memory: { initiative: [], workspace: [] } })),
    workspaceContext: vi.fn(),
    recall: vi.fn(async () => ({ initiative: [] })),
    remember: vi.fn(),
    reconcileActivity: vi.fn(async () => 0),
    settle: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    pendingCount: vi.fn(() => 0),
    timeline: vi.fn(() => []),
    shutdown: vi.fn(async () => undefined),
  };
  return runtime as unknown as WorkgraphRuntime;
}

function harness(runtime: WorkgraphRuntime, initiative?: string) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition & { loadMode?: string; approval?: string }>();
  const timers: Array<() => void> = [];
  const pi = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    registerTool: vi.fn((tool: ToolDefinition & { loadMode?: string; approval?: string }) => tools.set(tool.name, tool)),
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => initiative),
  } as unknown as ExtensionAPI;
  createWorkgraphOmpExtension({ runtimeFactory: () => runtime })(pi);
  const ui = {
    setStatus: vi.fn(),
    notify: vi.fn(),
    select: vi.fn(),
    input: vi.fn(),
  };
  const context = {
    hasUI: true,
    sessionManager: { buildContextEntries: vi.fn(() => []) },
    ui,
    setTimeout: vi.fn((callback: () => void) => {
      timers.push(callback);
      return timers.length;
    }),
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
  };
  return { handlers, tools, timers, ui, context };
}

afterEach(() => vi.restoreAllMocks());

describe("Workgraph OMP extension", () => {
  it("releases a waiting first turn when shutdown cancels the detached selector", async () => {
    const runtime = fakeRuntime();
    const loaded = harness(runtime);
    await loaded.handlers.get("session_start")!({}, loaded.context);
    const turn = loaded.handlers.get("before_agent_start")!({ prompt: "start", systemPrompt: [] }, loaded.context);
    await loaded.handlers.get("session_shutdown")!({}, loaded.context);
    await expect(turn).resolves.toBeUndefined();
    loaded.timers[0]();
    expect(loaded.ui.select).not.toHaveBeenCalled();
    expect(runtime.context).not.toHaveBeenCalled();
  });

  it("registers OMP lifecycle hooks and essential Workgraph tools", () => {
    const loaded = harness(fakeRuntime());

    expect([...loaded.handlers.keys()]).toEqual([
      "session_start", "before_agent_start", "session_stop", "session_before_compact", "session_shutdown",
    ]);
    expect([...loaded.tools.keys()]).toEqual([
      "initiative_memory_status", "initiative_memory_recall",
      "initiative_memory_remember", "initiative_timeline",
    ]);
    expect([...loaded.tools.values()].every((tool) => tool.loadMode === "essential")).toBe(true);
    expect(loaded.tools.get("initiative_memory_remember")?.approval).toBe("write");
    expect(["initiative_memory_status", "initiative_memory_recall", "initiative_timeline"]
      .every((name) => loaded.tools.get(name)?.approval === "read")).toBe(true);
  });

  it("returns from unscoped startup before showing a selector and defaults to no initiative after ten seconds", async () => {
    const runtime = fakeRuntime();
    const loaded = harness(runtime);
    loaded.ui.select.mockResolvedValue(undefined);

    await loaded.handlers.get("session_start")!({}, loaded.context);

    expect(loaded.timers).toHaveLength(1);
    expect(loaded.ui.select).not.toHaveBeenCalled();
    loaded.timers[0]();
    await vi.waitFor(() => expect(loaded.ui.select).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(loaded.ui.setStatus).toHaveBeenLastCalledWith("workgraph", "Workgraph: no initiative"));
    expect(runtime.lockInitiative).not.toHaveBeenCalled();
    expect(loaded.ui.select.mock.calls[0][2]).toMatchObject({
      timeout: 10_000,
      initialIndex: 2,
    });
  });

  it("holds the first unscoped turn until the detached selector resolves", async () => {
    const runtime = fakeRuntime();
    const loaded = harness(runtime);
    let finishSelector!: (value: undefined) => void;
    loaded.ui.select.mockReturnValue(new Promise((resolve) => { finishSelector = resolve; }));

    await loaded.handlers.get("session_start")!({}, loaded.context);
    loaded.timers[0]();
    await vi.waitFor(() => expect(loaded.ui.select).toHaveBeenCalledOnce());
    const beforeStart = loaded.handlers.get("before_agent_start")!({
      prompt: "Start",
      systemPrompt: ["Base prompt"],
    }, loaded.context);
    let finished = false;
    void beforeStart.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);

    finishSelector(undefined);
    await expect(beforeStart).resolves.toBeUndefined();
  });

  it.each([
    ["explicit", { MULTICA_WORKSPACE_ID: workspace }, "B-195"],
    ["managed", { MULTICA_WORKSPACE_ID: workspace, MULTICA_TASK_ID: task, MULTICA_AGENT_ID: agent }, undefined],
  ])("does not schedule the selector for %s scope", async (_name, env, initiative) => {
    const runtime = fakeRuntime(env);
    const loaded = harness(runtime, initiative);

    await loaded.handlers.get("session_start")!({}, loaded.context);

    expect(loaded.timers).toHaveLength(0);
    expect(loaded.ui.select).not.toHaveBeenCalled();
    expect(runtime.lockInitiative).toHaveBeenCalledOnce();
  });

  it("preserves OMP system prompt segments", async () => {
    const runtime = fakeRuntime();
    Object.defineProperty(runtime, "scope", { value: { initiativeIdentifier: "B-195" } });
    const loaded = harness(runtime);

    const result = await loaded.handlers.get("before_agent_start")!({
      prompt: "Continue B-195",
      systemPrompt: ["Base prompt", "Policy prompt"],
    }, loaded.context);

    expect(result.systemPrompt).toHaveLength(3);
    expect(result.systemPrompt.slice(0, 2)).toEqual(["Base prompt", "Policy prompt"]);
    expect(result.systemPrompt[2]).toContain("Authoritative current state");
  });

  it("defers settlement until OMP is idle with no pending messages", async () => {
    const runtime = fakeRuntime();
    Object.defineProperty(runtime, "scope", { value: { initiativeIdentifier: "B-195" } });
    const loaded = harness(runtime);

    loaded.context.isIdle.mockReturnValue(false);
    loaded.handlers.get("session_stop")!({}, loaded.context);
    expect(runtime.settle).not.toHaveBeenCalled();
    loaded.timers[0]();
    expect(runtime.settle).not.toHaveBeenCalled();
    expect(loaded.timers).toHaveLength(2);
    loaded.context.isIdle.mockReturnValue(true);
    loaded.timers[1]();
    await vi.waitFor(() => expect(runtime.settle).toHaveBeenCalledOnce());
  });

  it("discards deferred settlement when a new turn starts or shutdown occurs", async () => {
    const runtime = fakeRuntime();
    Object.defineProperty(runtime, "scope", { value: { initiativeIdentifier: "B-195" } });
    const loaded = harness(runtime);
    loaded.handlers.get("session_stop")!({}, loaded.context);
    await loaded.handlers.get("before_agent_start")!({ prompt: "Continue", systemPrompt: [] }, loaded.context);
    loaded.timers[0]();
    expect(runtime.settle).not.toHaveBeenCalled();

    loaded.handlers.get("session_stop")!({}, loaded.context);
    await loaded.handlers.get("session_shutdown")!({}, loaded.context);
    loaded.timers[1]();
    expect(runtime.settle).not.toHaveBeenCalled();
  });

  it("discards an aborted OMP settle pass", () => {
    const runtime = fakeRuntime();
    Object.defineProperty(runtime, "scope", { value: { initiativeIdentifier: "B-195" } });
    const loaded = harness(runtime);
    const controller = new AbortController();
    loaded.handlers.get("session_stop")!({ signal: controller.signal }, loaded.context);
    controller.abort();
    loaded.timers[0]();
    expect(runtime.settle).not.toHaveBeenCalled();
  });

  it("skips a stop with pending messages and settles at the next stop", async () => {
    const runtime = fakeRuntime();
    Object.defineProperty(runtime, "scope", { value: { initiativeIdentifier: "B-195" } });
    const loaded = harness(runtime);
    loaded.context.hasPendingMessages.mockReturnValue(true);
    loaded.handlers.get("session_stop")!({}, loaded.context);
    loaded.timers[0]();
    expect(runtime.settle).not.toHaveBeenCalled();
    loaded.context.hasPendingMessages.mockReturnValue(false);
    loaded.handlers.get("session_stop")!({}, loaded.context);
    loaded.timers[1]();
    await vi.waitFor(() => expect(runtime.settle).toHaveBeenCalledOnce());
  });
});
