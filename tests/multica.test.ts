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

function issue(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, workspace_id: workspace, identifier: id === root ? "B-184" : "B-185",
    status: "in_progress", status_category: "in_progress", parent_issue_id: id === root ? null : root,
    project_id: id === root ? rootProject : childProject, stage: 2, ...overrides,
  };
}

describe("Multica v0.4.35 initiative resolution", () => {
  it("parses required issue fields and follows the persisted chain across projects", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => issue(args[args.indexOf("get") + 1]));
    const resolution = await new MulticaReader({ run }).resolveIssue(child, workspace);
    expect(resolution.issue).toMatchObject({
      id: child, workspace_id: workspace, identifier: "B-185", project_id: childProject, stage: 2,
    });
    expect(resolution.root).toMatchObject({ id: root, identifier: "B-184", project_id: rootProject });
    expect(resolution.chain).toEqual([child, root]);
    expect(run.mock.calls.every(([, args]) => args.slice(0, 2).join(" ") === `--workspace-id ${workspace}`)).toBe(true);
  });

  it("rejects malformed v0.4.35 issue fields", async () => {
    for (const invalid of [
      issue(child, { id: "not-a-uuid" }), issue(child, { workspace_id: undefined }),
      issue(child, { identifier: " " }), issue(child, { status: undefined }),
      issue(child, { parent_issue_id: "parent" }), issue(child, { project_id: "project" }),
      issue(child, { stage: -1 }), issue(child, { stage: 0 }), issue(child, { stage: 1.5 }),
    ]) {
      const reader = new MulticaReader({ run: async () => invalid });
      await expect(reader.issue(child, workspace)).rejects.toThrow();
    }
  });

  it("validates every issue in the parent chain against the workspace", async () => {
    const reader = new MulticaReader({ run: async (_command, args) => {
      const id = args[args.indexOf("get") + 1];
      return issue(id, id === root ? { workspace_id: otherWorkspace } : {});
    } });
    await expect(reader.resolveIssue(child, workspace)).rejects.toThrow("different workspace");
  });

  it("detects cycles and enforces the parent depth limit", async () => {
    const cycleReader = new MulticaReader({ run: async (_command, args) => {
      const id = args[args.indexOf("get") + 1];
      return issue(id, { parent_issue_id: id === child ? root : child });
    } });
    await expect(cycleReader.resolveIssue(child, workspace)).rejects.toThrow("cycle");

    const depthReader = new MulticaReader({ maxDepth: 0, run: async () => issue(child) });
    await expect(depthReader.resolveIssue(child, workspace)).rejects.toThrow("safety limit");
  });

  it("resolves only a task matching its UUID, agent, workspace, and nonempty issue", async () => {
    const validTask = { id: task, agent_id: agent, workspace_id: workspace, issue_id: child };
    const run = vi.fn(async (_command: string, args: string[]) =>
      args.includes("tasks") ? [validTask] : issue(args[args.indexOf("get") + 1]));
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

  it("requires a valid workspace for every environment resolution", async () => {
    const reader = new MulticaReader({ run: vi.fn() });
    await expect(resolveFromEnvironment(reader, {})).rejects.toThrow("MULTICA_WORKSPACE_ID is required");
    await expect(resolveFromEnvironment(reader, { MULTICA_WORKSPACE_ID: "workspace" })).rejects.toThrow();
  });

  it("gives managed task provenance precedence and checks MULTICA_ISSUE_ID", async () => {
    const reader = new MulticaReader({ run: async (_command, args) =>
      args.includes("tasks")
        ? [{ id: task, agent_id: agent, workspace_id: workspace, issue_id: child }]
        : issue(args[args.indexOf("get") + 1]) });
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

  it("accepts only a root as an explicit interactive initiative", async () => {
    const reader = new MulticaReader({ run: async (_command, args) => issue(args[args.indexOf("get") + 1]) });
    await expect(resolveFromEnvironment(reader, { MULTICA_WORKSPACE_ID: workspace }, child)).rejects.toThrow("root Multica issue");
    expect((await resolveFromEnvironment(reader, { MULTICA_WORKSPACE_ID: workspace }, root))?.root.id).toBe(root);
  });
});
