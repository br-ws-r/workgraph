import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";
import type { WorkgraphRuntime } from "./runtime.js";
import { AUTHORITY_LEVELS, EDGE_TYPES, NODE_TYPES } from "./schema.js";

// Plain string enums work across both hosts and providers without loading a Pi SDK.
function stringEnum<const T extends readonly string[]>(values: T): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values] });
}

export function registerTools(
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
      scope: Type.Optional(stringEnum(["initiative", "workspace", "both"] as const)),
      top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
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
    ...writeHostOptions,
    name: "initiative_memory_remember",
    label: "Remember Initiative Memory",
    description: "Append one bounded, sourced record to the active initiative outbox for durable Cognee delivery.",
    parameters: Type.Object({
      entity_type: stringEnum(NODE_TYPES),
      authority: stringEnum(AUTHORITY_LEVELS),
      entity_identifier: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      entity_label: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
      source: Type.String({ minLength: 1, maxLength: 1000 }),
      source_revision: Type.Optional(Type.String({ maxLength: 256 })),
      relations: Type.Optional(Type.Array(Type.Object({
        type: stringEnum(EDGE_TYPES),
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
    ...readHostOptions,
    name: "initiative_timeline",
    label: "Initiative Timeline",
    description: "Read the exact chronological SQLite timeline for the immutable active initiative.",
    parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
    async execute(_id, params) {
      if (!runtime.scope) throw new Error("No initiative is selected; timeline is unavailable");
      await runtime.requireFreshResolution();
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


export function publicMemories(memories: Array<{
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

