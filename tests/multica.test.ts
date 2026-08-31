import { describe, expect, it, vi } from "vitest";
import { MulticaReader, resolveFromEnvironment } from "../src/multica.js";

const child = "00000000-0000-4000-8000-000000000002";
const root = "00000000-0000-4000-8000-000000000001";
const childProject = "00000000-0000-4000-8000-000000000012";
const rootProject = "00000000-0000-4000-8000-000000000011";

describe("Multica initiative resolution", () => {
  it("follows only persisted parent links to the canonical root", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      const id = args[args.indexOf("get") + 1];
      return id === child
        ? { id: child, title: "Child", parent_issue_id: root }
        : { id: root, title: "Initiative", parent_issue_id: null };
    });
    const reader = new MulticaReader({ run });
    const resolution = await reader.resolveIssue(child, "workspace");
    expect(resolution.root.id).toBe(root);
    expect(resolution.chain).toEqual([child, root]);
  });

  it("follows the canonical parent chain across Multica project boundaries", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      const id = args[args.indexOf("get") + 1];
      return id === child
        ? { id: child, project_id: childProject, parent_issue_id: root }
        : { id: root, project_id: rootProject, parent_issue_id: null };
    });
    const reader = new MulticaReader({ run });
    const resolution = await reader.resolveIssue(child, "workspace");
    expect(resolution.issue.project_id).toBe(childProject);
    expect(resolution.root.project_id).toBe(rootProject);
    expect(resolution.root.id).toBe(root);
    expect(resolution.chain).toEqual([child, root]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.every(([, args]) =>
      args.slice(0, 2).join(" ") === "--workspace-id workspace",
    )).toBe(true);
  });

  it("resolves the exact managed task and does not guess", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("tasks")) return [{ id: "task-1", issue_id: child }];
      const id = args[args.indexOf("get") + 1];
      return id === child ? { id: child, parent_issue_id: root } : { id: root, parent_issue_id: null };
    });
    const reader = new MulticaReader({ run });
    const resolution = await resolveFromEnvironment(reader, {
      MULTICA_WORKSPACE_ID: "workspace", MULTICA_TASK_ID: "task-1", MULTICA_AGENT_ID: "agent-1",
    });
    expect(resolution?.root.id).toBe(root);
  });

  it("rejects a child passed as --initiative", async () => {
    const reader = new MulticaReader({ run: async (_command, args) => {
      const id = args[args.indexOf("get") + 1];
      return id === child ? { id: child, parent_issue_id: root } : { id: root, parent_issue_id: null };
    } });
    await expect(resolveFromEnvironment(reader, {}, child)).rejects.toThrow("root Multica issue");
  });
});
