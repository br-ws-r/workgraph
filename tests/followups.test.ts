import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { FollowupStore, reconcileFollowups, FollowupCondition } from "../src/followups.js";
import { MulticaReader } from "../src/multica.js";

const workspace = "00000000-0000-4000-8000-000000000010";
const parentId = "00000000-0000-4000-8000-000000000001";
const childId = "00000000-0000-4000-8000-000000000002";
const parent = { id: parentId, workspace_id: workspace, identifier: "B-150", status: "in_progress",
  parent_issue_id: null, stage: null, project_id: null, assignee_type: "agent", assignee_id: "pm" };
const child = { ...parent, id: childId, identifier: "B-226", parent_issue_id: parentId };
const workspaceRecord = { id: workspace, slug: "brwsr", name: "brwsr" };
const workflowUrl = "https://github.com/br-ws-r/devbox/actions/runs/34353297838";
function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "followups-")), "store.db");
  const store = new FollowupStore(path);
  const multica = new MulticaReader({ run: vi.fn() });
  multica.workspace = vi.fn(async () => workspaceRecord);
  multica.resolveIssue = vi.fn(async (id) => ({ workspace: workspaceRecord, issue: id === parentId ? parent : child,
    root: parent, chain: id === parentId ? [parentId] : [childId, parentId], parent: id === parentId ? undefined : parent }));
  multica.activeRuns = vi.fn(async () => []);
  multica.rerun = vi.fn(async () => undefined);
  const input = { workspaceId: workspace, initiativeId: parentId, ownerId: parentId, ownerIdentifier: "B-150",
    assignment: "agent:pm", reason: "Verify B-150 after B-226 delivery", condition: { kind: "issue_terminal" as const, issueId: childId } };
  return { store, path, multica, input };
}
describe("durable delivery continuations", () => {
  it("B-226 completion survives restart and resumes B-150 exactly once across two workers", async () => {
    const f = fixture();
    const watch = f.store.add(f.input);
    expect(f.store.add(f.input).id).toBe(watch.id);
    f.store.close();
    const first = new FollowupStore(f.path), second = new FollowupStore(f.path);
    await reconcileFollowups(first, f.multica, workspace, true);
    expect(f.multica.rerun).not.toHaveBeenCalled(); // Merge/agent exit did not finish the issue.
    f.multica.resolveIssue = vi.fn(async (id) => ({ workspace: workspaceRecord,
      issue: id === parentId ? parent : { ...child, status: "done" }, root: parent,
      chain: id === parentId ? [parentId] : [childId, parentId] }));
    await Promise.all([reconcileFollowups(first, f.multica, workspace, true), reconcileFollowups(second, f.multica, workspace, true)]);
    expect(f.multica.rerun).toHaveBeenCalledTimes(1);
    expect(f.multica.rerun).toHaveBeenCalledWith(parentId, workspace);
    expect(first.list(workspace)[0].status).toBe("dispatched");
    first.close(); second.close();
  });
  it("failed workflow wakes its owner, dry-run and busy owners never dispatch", async () => {
    const f = fixture();
    f.store.add({ ...f.input, condition: { kind: "github_workflow", url: workflowUrl } });
    const workflow = vi.fn(async () => "failure");
    await reconcileFollowups(f.store, f.multica, workspace, false, workflow);
    expect(f.multica.rerun).not.toHaveBeenCalled();
    f.multica.activeRuns = vi.fn(async () => [{}]);
    await reconcileFollowups(f.store, f.multica, workspace, true, workflow);
    expect(f.store.list(workspace)[0].status).toBe("waiting");
    f.multica.activeRuns = vi.fn(async () => []);
    await reconcileFollowups(f.store, f.multica, workspace, true, workflow);
    expect(f.multica.rerun).toHaveBeenCalledTimes(1);
    expect(f.store.list(workspace)[0].observation).toContain("failure");
    f.store.close();
  });
  it("does not lose read failures or blindly retry an ambiguous rerun", async () => {
    const f = fixture();
    f.store.add({ ...f.input, condition: { kind: "github_workflow", url: workflowUrl } });
    await reconcileFollowups(f.store, f.multica, workspace, true, async () => { throw new Error("secret"); });
    expect(f.store.list(workspace)[0]).toMatchObject({ status: "waiting", observation: "read_failed; retry_on_next_poll" });
    f.multica.rerun = vi.fn(async () => { throw new Error("timeout after enqueue"); });
    await reconcileFollowups(f.store, f.multica, workspace, true, async () => "success");
    await reconcileFollowups(f.store, f.multica, workspace, true, async () => "success");
    expect(f.multica.rerun).toHaveBeenCalledTimes(1);
    expect(f.store.list(workspace)[0].status).toBe("dispatching");
    f.store.close();
  });
  it("holds a watch when ownership changes and rejects arbitrary workflow URLs", async () => {
    const f = fixture();
    f.store.add({ ...f.input, assignment: "agent:old", condition: { kind: "github_workflow", url: workflowUrl } });
    await reconcileFollowups(f.store, f.multica, workspace, true, async () => "success");
    expect(f.multica.rerun).not.toHaveBeenCalled();
    expect(f.store.list(workspace)[0].observation).toBe("owner_scope_or_assignment_changed");
    expect(() => FollowupCondition.parse({ kind: "github_workflow", url: "https://evil.test/run/1" })).toThrow();
    f.store.close();
  });
});

it("serializes different ready conditions for the same owner", async () => {
  const f = fixture();
  f.store.add({ ...f.input, condition: { kind: "github_workflow", url: workflowUrl } });
  f.store.add({ ...f.input, condition: { kind: "github_workflow", url: `${workflowUrl}1` } });
  const second = new FollowupStore(f.path);
  await Promise.all([
    reconcileFollowups(f.store, f.multica, workspace, true, async () => "success"),
    reconcileFollowups(second, f.multica, workspace, true, async () => "success"),
  ]);
  expect(f.multica.rerun).toHaveBeenCalledTimes(1);
  expect(f.store.list(workspace).map((watch) => watch.status).sort()).toEqual(["dispatched", "waiting"]);
  expect(f.store.executorStatus(workspace).recentlyObserved).toBe(true);
  second.close(); f.store.close();
});
