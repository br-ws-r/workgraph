import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InitiativeResolution } from "./multica.js";
import type { WorkgraphRuntime } from "./runtime.js";

// Both hosts expose this UI subset; OMP additionally accepts an initial selection.
type SelectionContext = Pick<ExtensionContext, "ui">;

export async function selectInitiative(
  runtime: WorkgraphRuntime,
  ctx: SelectionContext,
  options?: { signal: AbortSignal; timeoutMs: number },
): Promise<InitiativeResolution | undefined> {
  const workspaceId = runtime.env.MULTICA_WORKSPACE_ID?.trim()
    || (await runtime.multica.workspace()).id;
  const issues = await runtime.multica.recentRootInitiatives(workspaceId, 3);
  const projectLabels = new Map<string, string>();
  await Promise.all([...new Set(issues.flatMap((issue) => issue.project_id ? [issue.project_id] : []))]
    .map(async (projectId) => {
      try {
        const label = selectorProjectLabel((await runtime.multica.project(projectId, workspaceId)).title);
        if (label) projectLabels.set(projectId, label);
      } catch { /* project context is optional in the selector */ }
    }));
  const labels = issues.map((issue) => {
    const project = issue.project_id ? projectLabels.get(issue.project_id) : undefined;
    return `${issue.identifier}${project ? ` [${project}]` : ""} - ${issue.title ?? issue.identifier} [${issue.status ?? "unknown"}]`;
  });
  const enter = "Enter initiative ID (XYZ-123)";
  const none = "No initiative";
  const dialogOptions = options ? { signal: options.signal, timeout: options.timeoutMs, initialIndex: labels.length + 1 } : undefined;
  let selected: string | undefined;
  try {
    selected = options
      ? await ctx.ui.select("Select initiative", [...labels, enter, none], dialogOptions)
      : await ctx.ui.select("Select initiative", [...labels, enter, none]);
  } catch (error) {
    if (options?.signal.aborted) return undefined;
    throw error;
  }
  if (!selected || selected === none) return undefined;
  let issueId: string | undefined;
  try {
    issueId = selected === enter
      ? options
        ? await ctx.ui.input("Initiative ID (XYZ-123)", undefined, {
          signal: options.signal,
          timeout: options.timeoutMs,
        })
        : await ctx.ui.input("Initiative ID (XYZ-123)")
      : issues[labels.indexOf(selected)]?.identifier;
  } catch (error) {
    if (options?.signal.aborted) return undefined;
    throw error;
  }
  if (!issueId) return undefined;
  const resolution = await runtime.multica.resolveIssue(issueId, workspaceId);
  if (resolution.issue.id !== resolution.root.id) throw new Error("Interactive initiative selection must identify a root issue");
  return resolution;
}

function selectorProjectLabel(title: string): string {
  return title.normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
