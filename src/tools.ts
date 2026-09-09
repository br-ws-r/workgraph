import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "typebox";
import type { WorkgraphRuntime } from "./runtime.js";
import { AUTHORITY_LEVELS, EDGE_TYPES, NODE_TYPES } from "./schema.js";

// Plain string enums work across both hosts and providers without loading a Pi SDK.
function stringEnum<const T extends readonly string[]>(values: T): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values] });
}

/** Keep diagnostics available without creating a client, outbox, or write tools. */
export function registerUnavailableTools(pi: ExtensionAPI, host: "pi" | "omp", reason: string): void {
  pi.registerTool({
    ...(host === "omp" ? { loadMode: "essential" as const, approval: "read" as const } : {}),
    name: "initiative_memory_status",
    label: "Initiative Memory Status",
    description: "Report why Workgraph is unavailable; recall and writes are disabled for this session.",
    parameters: Type.Object({}),
    async execute() {
      return result({ mode: "unavailable", available: false, reason, pending_deliveries: null });
    },
  });
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
    ...writeHostOptions,
    name: "initiative_delivery_status", label: "Initiative Delivery Status",
    description: "Read fresh Multica children and issue status. Refreshes sourced issue graph state; Multica owns dispatch and completion.",
    parameters: Type.Object({}),
    async execute() { return result(await runtime.deliveryContext()); },
  });
  pi.registerTool({
    ...writeHostOptions,
    name: "initiative_handoffs_repair", label: "Repair Initiative Handoffs",
    description: "Reconsider authored handoffs on the selected issue since an explicit timestamp, including previously skipped comments. Idempotent; rejects incomplete history and retains provenance. Queues semantic delivery only.",
    parameters: Type.Object({ since: Type.String({ minLength: 1, maxLength: 64 }) }),
    async execute(_id, params) { return result({ queued: await runtime.repairHandoffs(params.since) }); },
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
      scope: Type.Optional(stringEnum(["initiative", "workspace", "both"] as const)),
      top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
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
        ...(recalled.errors ? { errors: recalled.errors } : {}),
      });
    },
  });

  pi.registerTool({
    ...writeHostOptions,
    name: "initiative_memory_remember",
    label: "Remember Initiative Memory",
    description: "Queue one bounded, sourced record for Cognee. Queued is not delivered: use initiative_timeline with the returned event_id to check delivery, then initiative_memory_recall to verify remote readability.",
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
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      event_id: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      entity_identifier: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      records: Type.Optional(stringEnum(["all", "explicit", "activity"] as const)),
    }),
    async execute(_id, params) {
      if (!runtime.scope) throw new Error("No initiative is selected; timeline is unavailable");
      await runtime.requireFreshResolution();
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
