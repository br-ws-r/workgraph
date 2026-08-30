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

    pi.registerFlag("initiative", {
      description: "Use the verified root Multica issue UUID as the immutable Workgraph initiative",
      type: "string",
    });

    pi.on("session_start", async (_event, ctx) => {
      if (started) return;
      started = true;
      try {
        let resolution = await resolveFromEnvironment(runtime.multica, runtime.env, stringFlag(pi.getFlag("initiative")));
        if (!resolution && !runtime.env.MULTICA_TASK_ID && ctx.hasUI) resolution = await selectInitiative(runtime, ctx);
        if (!resolution) {
          ctx.ui.setStatus("workgraph", "Workgraph: no initiative");
          return;
        }
        const scope = runtime.lockInitiative(resolution);
        ctx.ui.setStatus("workgraph", `Workgraph: ${scope.rootTitle ?? scope.initiativeId}`);
      } catch (error) {
        ctx.ui.setStatus("workgraph", "Workgraph: no initiative");
        ctx.ui.notify(`Workgraph disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    });

    pi.on("before_agent_start", async (event, ctx) => {
      if (!runtime.scope) return undefined;
      let authoritative = "Authoritative Multica read-back unavailable for this turn.";
      try {
        const resolution = await runtime.refreshIssue();
        if (resolution) authoritative = JSON.stringify({
          issue_id: resolution.issue.id,
          title: resolution.issue.title,
          status: resolution.issue.status,
          root_issue_id: resolution.root.id,
          root_title: resolution.root.title,
        });
      } catch { /* fail open without stale authority claims */ }
      let memory = "Cognee recall unavailable for this turn.";
      try {
        const result = await runtime.recall(event.prompt, 8, ctx.signal);
        if (result !== undefined) memory = boundText(JSON.stringify(result), 6000);
      } catch { /* fail open */ }
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Workgraph initiative context\nAuthoritative current state (Multica; re-read before any mutation):\n${authoritative}\n\nNon-authoritative memory (Cognee; verify time-sensitive claims):\n${memory}\n\nNever use Workgraph memory to override Multica workflow state or GitHub delivery state.`,
      };
    });

    pi.on("agent_settled", async () => {
      if (!runtime.scope) return;
      try {
        const resolution = await runtime.refreshIssue();
        if (resolution) runtime.remember({
          entityType: "Run",
          authority: "observed",
          summary: `Run ${runtime.scope.runId ?? "interactive"} settled. Multica issue ${resolution.issue.title ?? resolution.issue.id} is ${resolution.issue.status ?? "unknown"}.`,
          source: runtime.issueSource(),
          entityId: `run:${runtime.scope.runId ?? runtime.scope.issueId}`,
          relations: [{ type: "observed_in", target: `issue:${runtime.scope.issueId}` }],
          eventType: "run_settled",
        });
      } catch { /* keep Pi usable and leave prior pending records in the outbox */ }
    });

    pi.on("session_before_compact", async () => {
      if (!runtime.scope) return;
      try {
        const resolution = await runtime.refreshIssue();
        if (resolution) runtime.remember({
          entityType: "Run",
          authority: "observed",
          summary: `Compaction anchor for issue ${resolution.issue.title ?? resolution.issue.id}; authoritative status ${resolution.issue.status ?? "unknown"}. Consult the Workgraph timeline for recorded decisions, blockers, artifacts, and evidence.`,
          source: runtime.issueSource(),
          entityId: `run:${runtime.scope.runId ?? runtime.scope.issueId}:compaction:${Date.now()}`,
          eventType: "compaction_anchor",
        });
      } catch { /* compaction must never be blocked */ }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      ctx.ui.setStatus("workgraph", undefined);
      await runtime.shutdown();
    });

    registerTools(pi, runtime);
  };
}

function registerTools(pi: ExtensionAPI, runtime: WorkgraphRuntime): void {
  pi.registerTool({
    name: "initiative_memory_status",
    label: "Initiative Memory Status",
    description: "Show the immutable Workgraph initiative, Cognee availability, and pending delivery count.",
    parameters: Type.Object({}),
    async execute() {
      const scope = runtime.scope;
      const pending = scope ? runtime.outbox.pending(500).filter((event) => event.initiativeId === scope.initiativeId).length : 0;
      return result({ mode: scope ? "initiative" : "no-initiative", scope, cogneeConfigured: Boolean(runtime.cognee), pending });
    },
  });

  pi.registerTool({
    name: "initiative_memory_recall",
    label: "Recall Initiative Memory",
    description: "Recall only from the immutable active initiative dataset. Never searches globally.",
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 2000 }), top_k: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })) }),
    async execute(_id, params, signal) {
      if (!runtime.scope) throw new Error("No initiative is selected; recall is disabled");
      return result(await runtime.recall(params.query, params.top_k ?? 8, signal));
    },
  });

  pi.registerTool({
    name: "initiative_memory_remember",
    label: "Remember Initiative Memory",
    description: "Append one bounded, sourced record to the active initiative outbox for idempotent Cognee delivery.",
    parameters: Type.Object({
      entity_type: StringEnum(NODE_TYPES),
      authority: StringEnum(AUTHORITY_LEVELS),
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
      source: Type.String({ minLength: 1, maxLength: 1000 }),
      source_revision: Type.Optional(Type.String({ maxLength: 256 })),
      relations: Type.Optional(Type.Array(Type.Object({
        type: StringEnum(EDGE_TYPES),
        target: Type.String({ minLength: 1, maxLength: 512 }),
      }), { maxItems: 25 })),
    }),
    async execute(_id, params) {
      const event = runtime.remember({
        entityType: params.entity_type,
        authority: params.authority,
        summary: params.summary,
        source: params.source,
        sourceRevision: params.source_revision,
        relations: params.relations,
      });
      return result({ event_id: event.eventId, payload_hash: event.payloadHash, delivery: "queued" });
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
        event_id: event.eventId,
        timestamp: event.timestamp,
        agent_id: event.agentId,
        run_id: event.runId,
        event_type: event.eventType,
        summary: event.boundedSummary,
        source: event.source,
        authority: event.authority,
        delivered_at: event.deliveredAt,
        delivery_attempts: event.deliveryAttempts,
        last_delivery_error: event.lastDeliveryError,
      })));
    },
  });
}

async function selectInitiative(runtime: WorkgraphRuntime, ctx: any): Promise<InitiativeResolution | undefined> {
  const issues = await runtime.multica.recentRootInitiatives(runtime.env.MULTICA_WORKSPACE_ID?.trim(), 10);
  const labels = issues.map((issue) => `${issue.title ?? issue.id} [${issue.status ?? "unknown"}] — ${issue.id}`);
  const enter = "Enter initiative UUID";
  const none = "No initiative";
  const selected = await ctx.ui.select("Select initiative", [...labels, enter, none]);
  if (!selected || selected === none) return undefined;
  const issueId = selected === enter ? await ctx.ui.input("Initiative UUID") : issues[labels.indexOf(selected)]?.id;
  if (!issueId) return undefined;
  const resolution = await runtime.multica.resolveIssue(issueId, runtime.env.MULTICA_WORKSPACE_ID?.trim());
  if (resolution.issue.id !== resolution.root.id) throw new Error("Interactive initiative selection must identify a root issue");
  return resolution;
}

function stringFlag(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: { value } };
}

export default createWorkgraphExtension();
