import { describe, expect, it, vi } from "vitest";
import { MulticaReader, resolveFromEnvironment } from "../src/multica.js";

const workspace = "00000000-0000-4000-8000-000000000010";
const otherWorkspace = "00000000-0000-4000-8000-000000000020";
const child = "00000000-0000-4000-8000-000000000002";
const root = "00000000-0000-4000-8000-000000000001";
const task = "00000000-0000-4000-8000-000000000003";
const agent = "00000000-0000-4000-8000-000000000004";
const childProject = "00000000-0000-4000-8000-000000000012";
const rootProject = "00000000-0000-4000-8000-000000000011";
const activityA = "00000000-0000-4000-8000-000000000101";
const activityB = "00000000-0000-4000-8000-000000000102";

function issue(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, workspace_id: workspace, identifier: id === root ? "B-184" : "B-185",
    status: "in_progress", status_category: "in_progress", parent_issue_id: id === root ? null : root,
    project_id: id === root ? rootProject : childProject, stage: 2, ...overrides,
  };
}

function workspaceRecord(overrides: Record<string, unknown> = {}) {
  return { id: workspace, name: "BRWSR", slug: "brwsr", ...overrides };
}

function projectRecord(id: string) {
  return { id, workspace_id: workspace, title: id === childProject ? "Devbox" : "Workspace" };
}

function resolvedValue(args: string[], issueValue: (id: string) => unknown = issue): unknown {
  if (args[0] === "workspace") return workspaceRecord();
  if (args.includes("project")) return projectRecord(args[args.indexOf("get") + 1]);
  return issueValue(args[args.indexOf("get") + 1]);
}

describe("Multica v0.4.35 initiative resolution", () => {
  it("parses required issue fields and follows the persisted chain across projects", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => resolvedValue(args));
    const resolution = await new MulticaReader({ run }).resolveIssue(child, workspace);
    expect(resolution.issue).toMatchObject({
      id: child, workspace_id: workspace, identifier: "B-185", project_id: childProject, stage: 2,
    });
    expect(resolution.root).toMatchObject({ id: root, identifier: "B-184", project_id: rootProject });
    expect(resolution.workspace).toEqual(workspaceRecord());
    expect(resolution.parent).toMatchObject({ id: root, identifier: "B-184" });
    expect(resolution.project).toEqual(projectRecord(childProject));
    expect(resolution.chain).toEqual([child, root]);
    expect(run).toHaveBeenCalledWith("multica", ["workspace", "get", workspace, "--output", "json"]);
  });

  it("rejects malformed v0.4.35 issue fields", async () => {
    for (const invalid of [
      issue(child, { id: "not-a-uuid" }), issue(child, { workspace_id: undefined }),
      issue(child, { identifier: " " }), issue(child, { identifier: workspace }), issue(child, { status: undefined }),
      issue(child, { parent_issue_id: "parent" }), issue(child, { project_id: "project" }),
      issue(child, { stage: -1 }), issue(child, { stage: 0 }), issue(child, { stage: 1.5 }),
    ]) {
      const reader = new MulticaReader({ run: async () => invalid });
      await expect(reader.issue(child, workspace)).rejects.toThrow();
    }
  });

  it("re-reads identity-bearing workspace and project metadata", async () => {
    let workspaceReads = 0;
    let projectReads = 0;
    const reader = new MulticaReader({ run: async (_command, args) => {
      if (args[0] === "workspace") {
        workspaceReads += 1;
        return workspaceRecord({ slug: workspaceReads === 1 ? "brwsr" : "brwsr-renamed" });
      }
      if (args.includes("project")) {
        projectReads += 1;
        return { ...projectRecord(childProject), title: projectReads === 1 ? "Devbox" : "Devbox renamed" };
      }
      return issue(args[args.indexOf("get") + 1]);
    } });

    const first = await reader.resolveIssue(child, workspace);
    const second = await reader.resolveIssue(child, workspace);

    expect([first.workspace.slug, second.workspace.slug]).toEqual(["brwsr", "brwsr-renamed"]);
    expect([first.project?.title, second.project?.title]).toEqual(["Devbox", "Devbox renamed"]);
  });

  it("validates every issue in the parent chain against the workspace", async () => {
    const reader = new MulticaReader({ run: async (_command, args) => {
      if (args[0] === "workspace") return workspaceRecord();
      const id = args[args.indexOf("get") + 1];
      return issue(id, id === root ? { workspace_id: otherWorkspace } : {});
    } });
    await expect(reader.resolveIssue(child, workspace)).rejects.toThrow("different workspace");
  });

  it("detects cycles and enforces the parent depth limit", async () => {
    const cycleReader = new MulticaReader({ run: async (_command, args) => {
      if (args[0] === "workspace") return workspaceRecord();
      const id = args[args.indexOf("get") + 1];
      return issue(id, { parent_issue_id: id === child ? root : child });
    } });
    await expect(cycleReader.resolveIssue(child, workspace)).rejects.toThrow("cycle");

    const depthReader = new MulticaReader({ maxDepth: 0, run: async (_command, args) =>
      args[0] === "workspace" ? workspaceRecord() : issue(child) });
    await expect(depthReader.resolveIssue(child, workspace)).rejects.toThrow("safety limit");
  });

  it("resolves only a task matching its UUID, agent, workspace, and nonempty issue", async () => {
    const validTask = { id: task, agent_id: agent, workspace_id: workspace, issue_id: child };
    const run = vi.fn(async (_command: string, args: string[]) =>
      args.includes("tasks") ? [validTask] : resolvedValue(args));
    const resolution = await new MulticaReader({ run }).resolveTask(task, agent, workspace);
    expect(resolution).toMatchObject({ taskId: task, issue: { id: child }, root: { id: root } });

    for (const invalid of [
      { ...validTask, id: root }, { ...validTask, agent_id: root },
      { ...validTask, workspace_id: otherWorkspace }, { ...validTask, issue_id: " " },
    ]) {
      const reader = new MulticaReader({ run: async () => [invalid] });
      await expect(reader.resolveTask(task, agent, workspace)).rejects.toThrow();
    }
  });

  it("detects only a daemon-verified current chat context", async () => {
    const chatRun = vi.fn(async () => ({ messages: [] }));
    const chatReader = new MulticaReader({ run: chatRun });
    await expect(chatReader.isCurrentChat()).resolves.toBe(true);
    expect(chatRun).toHaveBeenCalledWith("multica", ["chat", "history", "--limit", "1", "--output", "json"]);

    const issueReader = new MulticaReader({ run: async () => { throw new Error("no chat task in context"); } });
    await expect(issueReader.isCurrentChat()).resolves.toBe(false);
  });

  it("requires a workspace only for managed resolution", async () => {
    const reader = new MulticaReader({ run: vi.fn() });
    await expect(resolveFromEnvironment(reader, {})).resolves.toBeUndefined();
    await expect(resolveFromEnvironment(reader, {
      MULTICA_TASK_ID: task, MULTICA_AGENT_ID: agent,
    })).rejects.toThrow("MULTICA_WORKSPACE_ID is required");
    await expect(resolveFromEnvironment(reader, {
      MULTICA_WORKSPACE_ID: "workspace", MULTICA_TASK_ID: task, MULTICA_AGENT_ID: agent,
    })).rejects.toThrow();
  });

  it("uses the current Multica workspace for an interactive initiative", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => resolvedValue(args, () => issue(root)));
    const resolved = await resolveFromEnvironment(new MulticaReader({ run }), {}, "B-184");

    expect(resolved?.workspace.slug).toBe("brwsr");
    expect(run).toHaveBeenNthCalledWith(1, "multica", ["workspace", "get", "--output", "json"]);
  });

  it("gives managed task provenance precedence and checks MULTICA_ISSUE_ID", async () => {
    const reader = new MulticaReader({ run: async (_command, args) =>
      args.includes("tasks")
        ? [{ id: task, agent_id: agent, workspace_id: workspace, issue_id: child }]
        : resolvedValue(args) });
    const env = {
      MULTICA_WORKSPACE_ID: workspace, MULTICA_TASK_ID: task,
      MULTICA_AGENT_ID: agent, MULTICA_ISSUE_ID: child,
    };
    expect((await resolveFromEnvironment(reader, env))?.root.id).toBe(root);
    await expect(resolveFromEnvironment(reader, { ...env, MULTICA_ISSUE_ID: root })).rejects.toThrow("does not match");
    await expect(resolveFromEnvironment(reader, env, root)).rejects.toThrow("cannot override");
  });

  it("requires managed task and agent together", async () => {
    const reader = new MulticaReader({ run: vi.fn() });
    await expect(resolveFromEnvironment(reader, {
      MULTICA_WORKSPACE_ID: workspace, MULTICA_TASK_ID: task,
    })).rejects.toThrow("provided together");
  });

  it("returns only the most recently updated active root initiatives", async () => {
    const records = [
      issue("00000000-0000-4000-8000-000000000031", { identifier: "B-201", parent_issue_id: null, updated_at: "2026-09-01T10:00:00Z" }),
      issue("00000000-0000-4000-8000-000000000032", { identifier: "B-202", parent_issue_id: null, updated_at: "2026-09-04T10:00:00Z" }),
      issue("00000000-0000-4000-8000-000000000033", { identifier: "B-203", parent_issue_id: null, updated_at: "2026-09-03T10:00:00Z" }),
      issue("00000000-0000-4000-8000-000000000034", { identifier: "B-204", parent_issue_id: null, updated_at: "2026-09-02T10:00:00Z" }),
      issue("00000000-0000-4000-8000-000000000035", { identifier: "B-205", parent_issue_id: null, status: "done", status_category: "done", updated_at: "2026-09-05T10:00:00Z" }),
      issue("00000000-0000-4000-8000-000000000036", { identifier: "B-206", parent_issue_id: root, updated_at: "2026-09-06T10:00:00Z" }),
    ];
    const run = vi.fn(async (_command: string, args: string[]) => {
      const offset = Number(args[args.indexOf("--offset") + 1]);
      return offset === 0
        ? { issues: records.slice(0, 3), has_more: true }
        : { issues: records.slice(3), has_more: false };
    });
    const reader = new MulticaReader({ run });

    const recent = await reader.recentRootInitiatives(workspace, 3);

    expect(recent.map((candidate) => candidate.identifier)).toEqual(["B-202", "B-203", "B-204"]);
    expect(run).toHaveBeenNthCalledWith(1, "multica", [
      "--workspace-id", workspace, "issue", "list", "--limit", "100", "--offset", "0", "--output", "json",
    ]);
    expect(run).toHaveBeenNthCalledWith(2, "multica", [
      "--workspace-id", workspace, "issue", "list", "--limit", "100", "--offset", "100", "--output", "json",
    ]);
  });

  it("accepts only a root as an explicit interactive initiative", async () => {
    const reader = new MulticaReader({ run: async (_command, args) => resolvedValue(args) });
    await expect(resolveFromEnvironment(reader, { MULTICA_WORKSPACE_ID: workspace }, child)).rejects.toThrow("root Multica issue");
    expect((await resolveFromEnvironment(reader, { MULTICA_WORKSPACE_ID: workspace }, root))?.root.id).toBe(root);
  });

  it("resolves an explicit root by its human-readable Multica identifier", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => resolvedValue(args, () => issue(root)));
    const reader = new MulticaReader({ run });

    const resolved = await resolveFromEnvironment(reader, { MULTICA_WORKSPACE_ID: workspace }, "b-184");

    expect(resolved?.root.id).toBe(root);
    expect(run).toHaveBeenCalledWith("multica", [
      "--workspace-id", workspace, "issue", "get", "B-184", "--output", "json",
    ]);
  });

  it("reads and validates the chronological Multica activity-only timeline", async () => {
    const runTimeline = vi.fn(async () => ({
      truncated: true,
      value: [
        {
          id: activityA, type: "activity", action: "created", actor_id: agent, actor_type: "agent",
          created_at: "2026-09-04T10:00:00Z", details: {},
        },
        {
          id: activityB, type: "activity", action: "status_changed", actor_id: "", actor_type: "system",
          created_at: "2026-09-04T10:00:01Z", details: { from: "in_review", to: "done" },
        },
      ],
    }));
    const result = await new MulticaReader({ runTimeline }).issueActivities(child, workspace);

    expect(result.truncated).toBe(true);
    expect(result.activities.map((activity) => activity.id)).toEqual([activityA, activityB]);
    expect(runTimeline).toHaveBeenCalledWith("multica", [
      "--workspace-id", workspace, "issue", "timeline", child, "--activity-only", "--output", "json",
    ]);
  });

  it("rejects malformed timeline entries", async () => {
    const reader = new MulticaReader({
      runTimeline: async () => ({ value: [{ id: "not-a-uuid", type: "comment" }], truncated: false }),
    });
    await expect(reader.issueActivities(child, workspace)).rejects.toThrow();
  });
});
