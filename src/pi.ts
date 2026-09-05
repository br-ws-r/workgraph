import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolveFromEnvironment, type InitiativeResolution } from "./multica.js";
import { WorkgraphRuntime, type WorkgraphRuntimeOptions } from "./runtime.js";
import { AUTHORITY_LEVELS, EDGE_TYPES, NODE_TYPES, boundText } from "./schema.js";

export interface WorkgraphPiOptions extends WorkgraphRuntimeOptions {
  runtimeFactory?: () => WorkgraphRuntime;
}

export function createWorkgraphExtension(options: WorkgraphPiOptions = {}) {
  return function workgraphExtension(pi: ExtensionAPI): void {
    const runtime = options.runtimeFactory?.() ?? new WorkgraphRuntime(options);
    let started = false;
    let workspaceChat = false;

    pi.registerFlag("initiative", {
      description: "Use a root Multica issue identifier such as B-184 (UUID also accepted for diagnostics)",
      type: "string",
    });

    pi.on("session_start", async (_event, ctx) => {
      if (started) return;
      started = true;
      try {
        workspaceChat = Boolean(runtime.env.MULTICA_TASK_ID?.trim() && runtime.env.MULTICA_AGENT_ID?.trim())
          && await runtime.multica.isCurrentChat();
        let resolution = workspaceChat
          ? undefined
          : await resolveFromEnvironment(runtime.multica, runtime.env, stringFlag(pi.getFlag("initiative")));
        if (!resolution && !runtime.env.MULTICA_TASK_ID && ctx.hasUI) resolution = await selectInitiative(runtime, ctx);
        if (!resolution) {
          ctx.ui.setStatus("workgraph", workspaceChat ? "Workgraph: workspace chat" : "Workgraph: no initiative");
          return;
        }
        const scope = runtime.lockInitiative(resolution);
        try {
          await runtime.reconcileActivity();
        } catch (error) {
          ctx.ui.notify(`Workgraph activity reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        ctx.ui.setStatus("workgraph", `Workgraph: ${scope.initiativeIdentifier}${scope.rootTitle ? ` — ${scope.rootTitle}` : ""}`);
      } catch (error) {
        ctx.ui.setStatus("workgraph", "Workgraph: no initiative");
        ctx.ui.notify(`Workgraph disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    });

    pi.on("before_agent_start", async (event, ctx) => {
      try {
        if (!runtime.scope) {
          if (!workspaceChat) return undefined;
          const context = await runtime.workspaceContext(event.prompt, 8, ctx.signal);
          const workspaceMemory = boundText(JSON.stringify(publicMemories(context.memory)), 3000);
          const memoryStatus = context.memoryError
            ? "Cognee workspace recall unavailable for this turn."
            : "Cognee workspace recall completed for this turn.";
          return {
            systemPrompt: `${event.systemPrompt}\n\n## Workgraph workspace context\nAuthoritative workspace identity (Multica):\n${JSON.stringify({ workspace_identifier: context.workspace.slug, workspace_name: context.workspace.name })}\n\nMemory status:\n${memoryStatus}\n\nNon-authoritative related workspace memory (Cognee):\n${workspaceMemory}\n\nNo initiative is selected. Do not write Workgraph memory or infer current workflow state from workspace memory.`,
          };
        }
        const context = await runtime.context(event.prompt, ctx.signal);
        const authoritative = JSON.stringify({
          issue_identifier: context.resolution.issue.identifier,
          title: context.resolution.issue.title,
          status: context.resolution.issue.status,
          status_category: context.resolution.issue.status_category,
          initiative_identifier: context.resolution.root.identifier,
          initiative_title: context.resolution.root.title,
        });
        const initiativeMemory = boundText(JSON.stringify(publicMemories(context.memory.initiative ?? [])), 6000);
        const workspaceHistory = boundText(JSON.stringify(publicMemories(context.memory.workspace ?? [])), 3000);
        const memoryStatus = context.memoryError
          ? "Cognee recall unavailable for this turn."
          : "Cognee recall completed for this turn.";
        return {
          systemPrompt: `${event.systemPrompt}\n\n## Workgraph workspace context\nAuthoritative current state (Multica; re-read before any mutation):\n${authoritative}\n\nUse human-readable Multica issue IDs such as B-184 in user-facing responses and commands. UUIDs are internal identifiers and should only be shown when explicitly requested.\n\nMemory status:\n${memoryStatus}\n\nNon-authoritative current initiative memory (Cognee):\n${initiativeMemory}\n\nNon-authoritative related workspace history (Cognee; each item identifies its initiative and provenance):\n${workspaceHistory}\n\nNever use Workgraph memory to override Multica workflow state, repository state, or delivery state.`,
        };
      } catch {
        return {
          systemPrompt: `${event.systemPrompt}\n\n## Workgraph workspace context\nAuthoritative Multica read-back was unavailable. Workgraph memory is omitted for this turn; do not rely on stale workflow or memory state.`,
        };
      }
    });

    pi.on("agent_settled", async () => {
      if (!runtime.scope) return;
      try {
        await runtime.settle();
      } catch { /* keep Pi usable and leave prior pending records in the outbox */ }
    });

    pi.on("session_before_compact", async () => {
      if (!runtime.scope) return;
      try {
        await runtime.compact();
      } catch { /* compaction must never be blocked */ }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      ctx.ui.setStatus("workgraph", undefined);
      await runtime.shutdown();
    });

    registerTools(pi, runtime, () => workspaceChat);
  };
}

function registerTools(pi: ExtensionAPI, runtime: WorkgraphRuntime, isWorkspaceChat: () => boolean): void {
  pi.registerTool({
    name: "initiative_memory_status",
    label: "Initiative Memory Status",
    description: "Show the immutable Workgraph initiative, Cognee availability, and pending semantic delivery count.",
    parameters: Type.Object({}),
    async execute() {
      const scope = runtime.scope;
      const pendingDeliveries = runtime.pendingCount();
      return result({
        mode: scope ? "initiative" : isWorkspaceChat() ? "workspace-chat" : "no-initiative",
        scope: scope ? {
          workspaceIdentifier: scope.workspaceIdentifier,
          workspaceName: scope.workspaceName,
          initiativeIdentifier: scope.initiativeIdentifier,
          issueIdentifier: scope.issueIdentifier,
          dataset: scope.dataset,
          stage: scope.stage,
          rootTitle: scope.rootTitle,
        } : undefined,
        cogneeConfigured: Boolean(runtime.cognee),
        pending_deliveries: pendingDeliveries,
      });
    },
  });

  pi.registerTool({
    name: "initiative_memory_recall",
    label: "Recall Initiative Memory",
    description: "Recall the current initiative or bounded related history within the locked workspace dataset.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
      scope: Type.Optional(StringEnum(["initiative", "workspace", "both"] as const)),
      top_k: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params, signal) {
      const requestedScope = params.scope ?? (runtime.scope ? "initiative" : "workspace");
      if (!runtime.scope) {
        if (!isWorkspaceChat()) throw new Error("No initiative is selected; recall is disabled");
        if (requestedScope !== "workspace") throw new Error("No initiative is selected; only workspace recall is available");
        const context = await runtime.workspaceContext(params.query, params.top_k ?? 8, signal);
        if (context.memoryError) throw new Error(context.memoryError);
        return result({ initiative: [], workspace: publicMemories(context.memory) });
      }
      const recalled = await runtime.recall(params.query, requestedScope, params.top_k ?? 8, signal);
      return result({
        initiative: publicMemories(recalled.initiative ?? []),
        workspace: publicMemories(recalled.workspace ?? []),
      });
    },
  });

  pi.registerTool({
    name: "initiative_memory_remember",
    label: "Remember Initiative Memory",
    description: "Append one bounded, sourced record to the active initiative outbox for durable Cognee delivery.",
    parameters: Type.Object({
      entity_type: StringEnum(NODE_TYPES),
      authority: StringEnum(AUTHORITY_LEVELS),
      entity_identifier: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      entity_label: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
      source: Type.String({ minLength: 1, maxLength: 1000 }),
      source_revision: Type.Optional(Type.String({ maxLength: 256 })),
      relations: Type.Optional(Type.Array(Type.Object({
        type: StringEnum(EDGE_TYPES),
        target: Type.String({
          minLength: 1,
          maxLength: 512,
          description: "Canonical node identifier such as issue:B-184; bare issue IDs are normalized automatically.",
        }),
      }), { maxItems: 25 })),
    }),
    async execute(_id, params) {
      const event = await runtime.remember({
        entityType: params.entity_type,
        entityIdentifier: params.entity_identifier,
        entityLabel: params.entity_label,
        authority: params.authority,
        summary: params.summary,
        source: params.source,
        sourceRevision: params.source_revision,
        relations: params.relations,
      });
      return result({ entity_identifier: event.memoryRecord!.entity_identifier, delivery: "queued" });
    },
  });

  pi.registerTool({
    name: "initiative_timeline",
    label: "Initiative Timeline",
    description: "Read the exact chronological SQLite timeline for the immutable active initiative.",
    parameters: Type.Object({ limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })) }),
    async execute(_id, params) {
      if (!runtime.scope) throw new Error("No initiative is selected; timeline is unavailable");
      return result(runtime.timeline(params.limit ?? 100).map((event) => ({
        timestamp: event.timestamp,
        event_type: event.eventType,
        workspace_identifier: runtime.scope!.workspaceIdentifier,
        initiative_identifier: event.initiativeIdentifier,
        issue_identifier: event.issueIdentifier,
        summary: event.boundedSummary,
        source: event.source,
        authority: event.authority,
        delivery: event.memoryRecord ? {
          status: event.deliveredAt ? "delivered" : "pending",
          attempts: event.deliveryAttempts,
          delivered_at: event.deliveredAt,
        } : undefined,
      })));
    },
  });
}

async function selectInitiative(runtime: WorkgraphRuntime, ctx: any): Promise<InitiativeResolution | undefined> {
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
  const selected = await ctx.ui.select("Select initiative", [...labels, enter, none]);
  if (!selected || selected === none) return undefined;
  const issueId = selected === enter ? await ctx.ui.input("Initiative ID (XYZ-123)") : issues[labels.indexOf(selected)]?.identifier;
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

function stringFlag(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function publicMemories(memories: Array<{
  initiativeIdentifier: string;
  entityType: string;
  entityIdentifier: string;
  entityLabel: string;
  authority: string;
  summary: string;
  source: string;
  observedAt: string;
}>) {
  return memories.map((memory) => ({
    initiative_identifier: memory.initiativeIdentifier,
    entity_type: memory.entityType,
    entity_identifier: memory.entityIdentifier,
    entity_label: memory.entityLabel,
    authority: memory.authority,
    summary: memory.summary,
    source: memory.source,
    observed_at: memory.observedAt,
  }));
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: { value } };
}

export default createWorkgraphExtension();
