import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const NODE_TYPES = [
  "Issue", "Task", "Agent", "Squad", "Handoff", "Decision", "Blocker",
  "Artifact", "Repository", "Run", "Evidence", "Conflict",
] as const;

export const EDGE_TYPES = [
  "root_of", "child_of", "assigned_to", "owned_by", "delegated_to",
  "blocked_by", "depends_on", "produced", "for", "supports", "from",
  "about", "verified_by", "implemented_in", "observed_in",
] as const;

export const AUTHORITY_LEVELS = ["observed", "confirmed", "proposed", "inferred"] as const;

export const EVENT_TYPES = [
  "initiative_selected", "run_started", "context_recalled", "decision_recorded",
  "blocker_recorded", "artifact_observed", "handoff_observed", "evidence_recorded",
  "run_settled", "compaction_anchor", "memory_delivery_succeeded",
  "memory_delivery_failed",
] as const;

export const NodeTypeSchema = z.enum(NODE_TYPES);
export const EdgeTypeSchema = z.enum(EDGE_TYPES);
export const AuthoritySchema = z.enum(AUTHORITY_LEVELS);
export const EventTypeSchema = z.enum(EVENT_TYPES);

export const RelationSchema = z.object({
  type: EdgeTypeSchema,
  target: z.string().min(1).max(512),
});

export const MemoryRecordSchema = z.object({
  entity_type: NodeTypeSchema,
  authority: AuthoritySchema,
  initiative_id: z.string().uuid(),
  entity_id: z.string().min(1).max(512),
  summary: z.string().min(1).max(4000),
  relations: z.array(RelationSchema).max(25).default([]),
  source: z.string().min(1).max(1000),
  source_revision: z.string().max(256).optional(),
  observed_at: z.string().datetime({ offset: true }),
});

export type NodeType = z.infer<typeof NodeTypeSchema>;
export type EdgeType = z.infer<typeof EdgeTypeSchema>;
export type Authority = z.infer<typeof AuthoritySchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export interface WorkgraphEventInput {
  eventId?: string;
  timestamp?: string;
  workspaceId?: string;
  initiativeId: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  eventType: EventType;
  boundedSummary: string;
  source: string;
  sourceRevision?: string;
  authority: Authority;
  memoryRecord?: MemoryRecord;
}

export interface WorkgraphEvent extends WorkgraphEventInput {
  eventId: string;
  timestamp: string;
  payloadHash: string;
}

export function createEvent(input: WorkgraphEventInput): WorkgraphEvent {
  const boundedSummary = boundText(input.boundedSummary, 4000);
  const canonical = JSON.stringify({
    workspaceId: input.workspaceId ?? null,
    initiativeId: input.initiativeId,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    agentId: input.agentId ?? null,
    eventType: input.eventType,
    boundedSummary,
    source: input.source,
    sourceRevision: input.sourceRevision ?? null,
    authority: input.authority,
    memoryRecord: input.memoryRecord ?? null,
  });
  return {
    ...input,
    eventId: input.eventId ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    boundedSummary,
    payloadHash: createHash("sha256").update(canonical).digest("hex"),
  };
}

export function datasetForInitiative(initiativeId: string): string {
  return `brwsr-initiative-${z.string().uuid().parse(initiativeId).toLowerCase()}`;
}

export function boundText(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, Math.max(0, maximum - 1))}…`;
}
