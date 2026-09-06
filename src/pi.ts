import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolveFromEnvironment, type InitiativeResolution } from "./multica.js";
import { WorkgraphRuntime, type WorkgraphRuntimeOptions } from "./runtime.js";
import { AUTHORITY_LEVELS, EDGE_TYPES, NODE_TYPES, boundText } from "./schema.js";

export interface WorkgraphPiOptions extends WorkgraphRuntimeOptions {
  runtimeFactory?: () => WorkgraphRuntime;
}

type OmpExtensionContext = ExtensionContext & {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
};

export function createWorkgraphExtension(options: WorkgraphPiOptions = {}) {
  return createWorkgraphHostExtension("pi", options);
}

export function createWorkgraphOmpExtension(options: WorkgraphPiOptions = {}) {
  return createWorkgraphHostExtension("omp", options);
}

function createWorkgraphHostExtension(host: "pi" | "omp", options: WorkgraphPiOptions) {
  return function workgraphExtension(pi: ExtensionAPI): void {
    const runtime = options.runtimeFactory?.() ?? new WorkgraphRuntime(options);
    let started = false;
    let workspaceChat = false;
    let bootstrapWorkspaceChat = false;
    let selectorController: AbortController | undefined;
    let selectionPending: Promise<void> | undefined;
    let shuttingDown = false;
    let settleGeneration = 0;

    pi.registerFlag("initiative", {
      description: "Use a root Multica issue identifier such as B-184 (UUID also accepted for diagnostics)",
      type: "string",
    });

    pi.on("session_start", async (_event, ctx) => {
      if (started) {
        if (workspaceChat) bootstrapWorkspaceChat = isFreshSession(ctx);
        return;
      }
      started = true;
      try {
        workspaceChat = Boolean(runtime.env.MULTICA_TASK_ID?.trim() && runtime.env.MULTICA_AGENT_ID?.trim())
          && await runtime.multica.isCurrentChat();
        bootstrapWorkspaceChat = workspaceChat && isFreshSession(ctx);
        let resolution = workspaceChat
          ? undefined
          : await resolveFromEnvironment(runtime.multica, runtime.env, stringFlag(pi.getFlag("initiative")));
        if (!resolution && !runtime.env.MULTICA_TASK_ID && ctx.hasUI) {
          if (host === "omp") {
            selectorController = new AbortController();
            ctx.ui.setStatus("workgraph", "Workgraph: select initiative");
            let finishSelection!: () => void;
            selectionPending = new Promise<void>((resolve) => { finishSelection = resolve; });
            (ctx as OmpExtensionContext).setTimeout(() => {
              void selectInitiative(runtime, ctx, {
                signal: selectorController!.signal,
                timeoutMs: 10_000,
              }).then(async (selected) => {
                if (!selected || shuttingDown) {
                  ctx.ui.setStatus("workgraph", "Workgraph: no initiative");
                  return;
                }
                await activateResolution(runtime, selected, ctx, () => shuttingDown);
              }).catch((error) => {
                if (shuttingDown) return;
                ctx.ui.setStatus("workgraph", "Workgraph: no initiative");
                ctx.ui.notify(`Workgraph disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
              }).finally(finishSelection);
            }, 0);
            return;
          }
          resolution = await selectInitiative(runtime, ctx);
        }
        if (!resolution) {
          ctx.ui.setStatus("workgraph", workspaceChat ? "Workgraph: workspace chat" : "Workgraph: no initiative");
          return;
        }
        await activateResolution(runtime, resolution, ctx);
      } catch (error) {
        ctx.ui.setStatus("workgraph", "Workgraph: no initiative");
        ctx.ui.notify(`Workgraph disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    });

    const beforeAgentStart = async (
      event: { prompt: string; systemPrompt: string | string[] },
      ctx: ExtensionContext,
    ) => {
      if (host === "omp") {
        settleGeneration++; // A new turn invalidates any deferred stop callback.
        await selectionPending;
      }
      try {
        if (!runtime.scope) {
          if (!workspaceChat) return undefined;
          if (bootstrapWorkspaceChat) {
            bootstrapWorkspaceChat = false;
            const context = await runtime.workspaceContext(event.prompt, 8, ctx.signal);
            const workspaceMemory = boundText(JSON.stringify(publicMemories(context.memory)), 9000);
            const memoryStatus = context.memoryError
              ? "Cognee bootstrap recall unavailable."
              : "Cognee bootstrap recall completed for this fresh session.";
            return withSystemPrompt(event.systemPrompt, `## Workgraph workspace chat\nNo initiative is selected. Verified workspace: ${context.workspace.name} (${context.workspace.slug}).\n\nMemory status:\n${memoryStatus}\n\nNon-authoritative related workspace memory (Cognee; each item identifies its initiative and provenance):\n${workspaceMemory}\n\nAdditional read-only workspace recall is available through initiative_memory_recall with workspace scope. Do not write Workgraph memory or infer current workflow state from recalled memory.`);
          }
          return withSystemPrompt(event.systemPrompt, "## Workgraph workspace chat\nNo initiative is selected. Read-only workspace memory is available on demand through initiative_memory_recall with workspace scope. Use it only when prior workspace context could materially help. Do not write Workgraph memory or infer current workflow state from recalled memory.");
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
        return withSystemPrompt(event.systemPrompt, `## Workgraph workspace context\nAuthoritative current state (Multica; re-read before any mutation):\n${authoritative}\n\nUse human-readable Multica issue IDs such as B-184 in user-facing responses and commands. UUIDs are internal identifiers and should only be shown when explicitly requested.\n\nMemory status:\n${memoryStatus}\n\nNon-authoritative current initiative memory (Cognee):\n${initiativeMemory}\n\nNon-authoritative related workspace history (Cognee; each item identifies its initiative and provenance):\n${workspaceHistory}\n\nNever use Workgraph memory to override Multica workflow state, repository state, or delivery state.`);
      } catch {
        return withSystemPrompt(event.systemPrompt, "## Workgraph workspace context\nAuthoritative Multica read-back was unavailable. Workgraph memory is omitted for this turn; do not rely on stale workflow or memory state.");
      }
    };
    (pi.on as unknown as (
      event: "before_agent_start",
      handler: typeof beforeAgentStart,
    ) => void)("before_agent_start", beforeAgentStart);

    if (host === "pi") {
      pi.on("agent_settled", async () => {
        if (!runtime.scope) return;
        try {
          await runtime.settle();
        } catch { /* keep Pi usable and leave prior pending records in the outbox */ }
      });
    } else {
      (pi.on as unknown as (
        event: "session_stop",
        handler: (event: { signal?: AbortSignal }, ctx: OmpExtensionContext) => void,
      ) => void)("session_stop", (event, ctx) => {
        const generation = ++settleGeneration;
        const settleWhenIdle = () => {
          if (shuttingDown || event.signal?.aborted || generation !== settleGeneration
            || !runtime.scope || ctx.hasPendingMessages()) return;
          if (!ctx.isIdle()) {
            ctx.setTimeout(settleWhenIdle, 25);
            return;
          }
          void runtime.settle().catch(() => undefined);
        };
        ctx.setTimeout(settleWhenIdle, 0);
      });
    }

    pi.on("session_before_compact", async () => {
      if (!runtime.scope) return;
      try {
        await runtime.compact();
      } catch { /* compaction must never be blocked */ }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      shuttingDown = true;
      settleGeneration++;
      selectorController?.abort();
      ctx.ui.setStatus("workgraph", undefined);
      await runtime.shutdown();
    });

    registerTools(pi, runtime, () => workspaceChat, host);
  };
}

async function activateResolution(
  runtime: WorkgraphRuntime,
  resolution: InitiativeResolution,
  ctx: any,
  isShuttingDown: () => boolean = () => false,
): Promise<void> {
  if (isShuttingDown()) return;
  const scope = runtime.lockInitiative(resolution);
  try {
    await runtime.reconcileActivity();
  } catch (error) {
    ctx.ui.notify(`Workgraph activity reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
  if (!isShuttingDown()) {
    ctx.ui.setStatus("workgraph", `Workgraph: ${scope.initiativeIdentifier}${scope.rootTitle ? ` — ${scope.rootTitle}` : ""}`);
  }
}

function withSystemPrompt(systemPrompt: string | string[], workgraphPrompt: string): { systemPrompt: string | string[] } {
  return {
    systemPrompt: Array.isArray(systemPrompt)
      ? [...systemPrompt, workgraphPrompt]
      : `${systemPrompt}\n\n${workgraphPrompt}`,
  };
}

function registerTools(
  pi: ExtensionAPI,
  runtime: WorkgraphRuntime,
  isWorkspaceChat: () => boolean,
  host: "pi" | "omp",
): void {
  const readHostOptions = host === "omp"
    ? { loadMode: "essential" as const, approval: "read" as const }
    : {};
  const writeHostOptions = host === "omp"
    ? { loadMode: "essential" as const, approval: "write" as const }
    : {};
  pi.registerTool({
    ...readHostOptions,
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
    ...readHostOptions,
    name: "initiative_memory_recall",
    label: "Recall Initiative Memory",
    description: "Recall the current initiative or bounded related history; workspace-only recall is available on demand in verified chats.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
      entity_identifier: Type.Optional(Type.String({
        minLength: 1, maxLength: 512,
        description: "Exact entity filter within the active initiative. Results always come from Cognee; a local record may help form one retry query.",
      })),
      scope: Type.Optional(StringEnum(["initiative", "workspace", "both"] as const)),
      top_k: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params, signal) {
      const requestedScope = params.scope ?? (runtime.scope ? "initiative" : "workspace");
      if (params.entity_identifier !== undefined) {
        if (!runtime.scope || requestedScope !== "initiative") {
          throw new Error("Exact entity recall requires the active initiative scope");
        }
        const recalled = await runtime.recallEntity(params.query, params.entity_identifier, signal);
        return result({ initiative: publicMemories(recalled.initiative ?? []), workspace: [] });
      }
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
    ...writeHostOptions,
    name: "initiative_memory_remember",
    label: "Remember Initiative Memory",
    description: "Queue one bounded, sourced record for Cognee. Queued is not delivered: use initiative_timeline with the returned event_id to check delivery, then initiative_memory_recall to verify remote readability.",
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
      return result({
        event_id: event.eventId,
        entity_identifier: event.memoryRecord!.entity_identifier,
        delivery: "queued",
      });
    },
  });

  pi.registerTool({
    ...readHostOptions,
    name: "initiative_timeline",
    label: "Initiative Timeline",
    description: "Read the local SQLite delivery ledger, not Cognee recall. Filter by event_id or entity_identifier for exact lookup; records=explicit hides automatic activity. A delivered entry alone does not prove remote recall.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      event_id: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      entity_identifier: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      records: Type.Optional(StringEnum(["all", "explicit", "activity"] as const)),
    }),
    async execute(_id, params) {
      if (!runtime.scope) throw new Error("No initiative is selected; timeline is unavailable");
      return result(runtime.timeline(params.limit ?? 100, {
        eventId: params.event_id, entityIdentifier: params.entity_identifier, records: params.records,
      }).map((event) => ({
        event_id: event.eventId,
        entity_identifier: event.memoryRecord?.entity_identifier,
        entity_type: event.memoryRecord?.entity_type,
        node_sets: event.nodeSets,
        relations: event.memoryRecord?.relations,
        storage: "local_outbox",
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

async function selectInitiative(
  runtime: WorkgraphRuntime,
  ctx: any,
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
  let selected: string | undefined;
  try {
    selected = options
      ? await ctx.ui.select("Select initiative", [...labels, enter, none], {
        signal: options.signal,
        timeout: options.timeoutMs,
        initialIndex: labels.length + 1,
      })
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

function stringFlag(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isFreshSession(ctx: { sessionManager: { buildContextEntries(): Array<{ type: string }> } }): boolean {
  return !ctx.sessionManager.buildContextEntries()
    .some((entry) => ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type));
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
