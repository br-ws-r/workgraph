import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const SCHEMA_VERSION = "3.0.0" as const;
export const EXTRACTION_PROMPT_VERSION = "2.0.0" as const;
export const EXTRACTION_PROMPT = `Extract only the bounded Workgraph entity and relation types in schema ${SCHEMA_VERSION}.
Use entity_label, bounded summaries, and *_identifier fields for concise human-readable node names.
Treat *_id UUIDs, source_revision, hashes, timestamps, and source URLs as opaque provenance attributes; never use them as node display names.
Preserve stable semantic identifiers, source provenance, observation time, and authority exactly as supplied.
Do not invent current state, identifiers, relations, or authority. Treat remembered summaries as historical context.
Entity types: Initiative, Issue, Task, Agent, Squad, Decision, Constraint, Risk, Blocker, Handoff, Artifact, Evidence, Run, Outcome, Conflict.
Relation types: root_of, child_of, part_of, assigned_to, owned_by, delegated_to, blocked_by, depends_on, produced, supports, contradicts, derived_from, about, verified_by, resulted_in, observed_in, related_to.`;

export const NODE_TYPES = [
  "Initiative", "Issue", "Task", "Agent", "Squad", "Decision", "Constraint",
  "Risk", "Blocker", "Handoff", "Artifact", "Evidence", "Run", "Outcome",
  "Conflict",
] as const;

export const EDGE_TYPES = [
  "root_of", "child_of", "part_of", "assigned_to", "owned_by", "delegated_to",
  "blocked_by", "depends_on", "produced", "supports", "contradicts",
  "derived_from", "about", "verified_by", "resulted_in", "observed_in",
  "related_to",
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

const UuidSchema = z.string().uuid();
const StructuredIdentifierSchema = z.string().trim().min(1).max(256);
const FullUuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ReadableIdentifierSchema = StructuredIdentifierSchema.refine(
  (value) => !FullUuidPattern.test(value),
  "Readable identifiers must not contain internal UUIDs",
);
const SemanticIdentifierSchema = z.string().trim().min(1).max(512).refine(
  (value) => !FullUuidPattern.test(value),
  "Semantic identifiers must not contain internal UUIDs",
);
const NodeSetSchema = z.string().min(3).max(128).regex(
  /^(?:initiative|type|authority|project|stage|repo):[A-Za-z0-9](?:[A-Za-z0-9._-]{0,95})$/,
).refine((value) => !FullUuidPattern.test(value), "NodeSets must not contain internal UUIDs");

export interface NodeSetScope {
  initiativeIdentifier: string;
  entityType: NodeType;
  authority: Authority;
  projectIdentifier?: string | null;
  parentIssueIdentifier?: string | null;
  stage?: number | null;
  repositoryIdentifier?: string | null;
}

/** Derives the complete NodeSet list; callers cannot append their own labels. */
export function deriveNodeSets(scope: NodeSetScope): string[] {
  const entityType = NodeTypeSchema.parse(scope.entityType);
  const authority = AuthoritySchema.parse(scope.authority);
  const nodeSets = [
    initiativeNodeSet(scope.initiativeIdentifier),
    `type:${normalizeNodeSetValue(entityType.toLowerCase())}`,
    `authority:${normalizeNodeSetValue(authority)}`,
  ];
  if (scope.projectIdentifier != null) {
    nodeSets.push(`project:${normalizeNodeSetValue(scope.projectIdentifier)}`);
  }
  if (scope.stage != null && scope.parentIssueIdentifier != null) {
    const parentIssueIdentifier = normalizeNodeSetValue(scope.parentIssueIdentifier);
    nodeSets.push(`stage:${parentIssueIdentifier}-${z.number().int().positive().parse(scope.stage)}`);
  }
  if (scope.repositoryIdentifier != null) {
    nodeSets.push(`repo:${normalizeNodeSetValue(scope.repositoryIdentifier)}`);
  }
  return nodeSets;
}

export const RelationSchema = z.object({
  type: EdgeTypeSchema,
  target: SemanticIdentifierSchema,
}).strict();

export const MemoryRecordSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  extraction_prompt_version: z.literal(EXTRACTION_PROMPT_VERSION),
  workspace_id: UuidSchema,
  workspace_identifier: ReadableIdentifierSchema,
  workspace_name: StructuredIdentifierSchema.optional(),
  initiative_id: UuidSchema,
  initiative_identifier: ReadableIdentifierSchema,
  issue_id: UuidSchema,
  issue_identifier: ReadableIdentifierSchema,
  entity_type: NodeTypeSchema,
  authority: AuthoritySchema,
  entity_identifier: SemanticIdentifierSchema,
  entity_label: z.string().trim().min(1).max(256).refine(
    (value) => !FullUuidPattern.test(value),
    "Entity labels must not contain internal UUIDs",
  ),
  summary: z.string().trim().min(1).max(4000),
  relations: z.array(RelationSchema).max(25).default([]),
  node_sets: z.array(NodeSetSchema).min(3).max(6),
  project_id: UuidSchema.nullish(),
  project_identifier: ReadableIdentifierSchema.nullish(),
  parent_issue_id: UuidSchema.nullish(),
  parent_issue_identifier: ReadableIdentifierSchema.nullish(),
  stage: z.number().int().positive().nullish(),
  repository_identifier: ReadableIdentifierSchema.nullish(),
  source: z.string().trim().min(1).max(1000),
  source_revision: z.string().max(256).optional(),
  observed_at: z.string().datetime({ offset: true }),
}).strict().superRefine((record, context) => {
  for (const [idField, identifierField] of [
    ["project_id", "project_identifier"],
    ["parent_issue_id", "parent_issue_identifier"],
  ] as const) {
    if ((record[idField] == null) !== (record[identifierField] == null)) {
      context.addIssue({
        code: "custom",
        path: [identifierField],
        message: `${idField} and ${identifierField} must be provided together`,
      });
    }
  }
  let expected: string[];
  try {
    expected = deriveNodeSets({
      initiativeIdentifier: record.initiative_identifier,
      entityType: record.entity_type,
      authority: record.authority,
      projectIdentifier: record.project_identifier,
      parentIssueIdentifier: record.parent_issue_identifier,
      stage: record.stage,
      repositoryIdentifier: record.repository_identifier,
    });
  } catch {
    return;
  }
  if (record.node_sets.length !== expected.length || record.node_sets.some((value, index) => value !== expected[index])) {
    context.addIssue({
      code: "custom",
      path: ["node_sets"],
      message: "NodeSets must exactly match the deterministic server-derived scope",
    });
  }
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > 12_000) {
    context.addIssue({
      code: "custom",
      message: "Memory record exceeds the single-chunk semantic payload limit",
    });
  }
});

export type NodeType = z.infer<typeof NodeTypeSchema>;
export type EdgeType = z.infer<typeof EdgeTypeSchema>;
export type Authority = z.infer<typeof AuthoritySchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export interface WorkgraphEventInput {
  eventId?: string;
  timestamp?: string;
  workspaceId: string;
  initiativeId: string;
  initiativeIdentifier: string;
  issueId: string;
  issueIdentifier: string;
  projectId?: string;
  nodeSets: string[];
  schemaVersion: string;
  extractionPromptVersion: string;
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
  UuidSchema.parse(input.workspaceId);
  UuidSchema.parse(input.initiativeId);
  UuidSchema.parse(input.issueId);
  if (input.projectId) UuidSchema.parse(input.projectId);
  ReadableIdentifierSchema.parse(input.initiativeIdentifier);
  ReadableIdentifierSchema.parse(input.issueIdentifier);
  z.array(NodeSetSchema).min(3).max(6).parse(input.nodeSets);
  z.literal(SCHEMA_VERSION).parse(input.schemaVersion);
  z.literal(EXTRACTION_PROMPT_VERSION).parse(input.extractionPromptVersion);
  if (input.memoryRecord) {
    const record = MemoryRecordSchema.parse(input.memoryRecord);
    if (record.workspace_id !== input.workspaceId
      || record.initiative_id !== input.initiativeId
      || record.initiative_identifier !== input.initiativeIdentifier
      || record.issue_id !== input.issueId
      || record.issue_identifier !== input.issueIdentifier
      || (record.project_id ?? undefined) !== input.projectId
      || record.schema_version !== input.schemaVersion
      || record.extraction_prompt_version !== input.extractionPromptVersion
      || record.node_sets.length !== input.nodeSets.length
      || record.node_sets.some((value, index) => value !== input.nodeSets[index])) {
      throw new Error("Event envelope does not match its memory record");
    }
  }
  const boundedSummary = boundText(input.boundedSummary, 4000);
  const canonical = JSON.stringify({
    workspaceId: input.workspaceId,
    initiativeId: input.initiativeId,
    initiativeIdentifier: input.initiativeIdentifier,
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    projectId: input.projectId ?? null,
    nodeSets: input.nodeSets,
    schemaVersion: input.schemaVersion,
    extractionPromptVersion: input.extractionPromptVersion,
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

export function datasetForWorkspace(workspaceIdentifier: string): string {
  ReadableIdentifierSchema.parse(workspaceIdentifier);
  return `workgraph-workspace-${normalizeNodeSetValue(workspaceIdentifier).toLowerCase()}`;
}

export function boundText(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, Math.max(0, maximum - 1))}…`;
}

export function initiativeNodeSet(identifier: string): string {
  return `initiative:${normalizeNodeSetValue(identifier)}`;
}

function normalizeNodeSetValue(value: string): string {
  const original = ReadableIdentifierSchema.parse(value);
  const normalized = original
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/[-._]{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  if (!normalized) throw new Error("NodeSet identifier contains no safe characters");
  if (normalized === original && normalized.length <= 96) return normalized;
  const suffix = createHash("sha256").update(original).digest("hex").slice(0, 10);
  const prefix = normalized.slice(0, 85).replace(/[-._]+$/g, "");
  return `${prefix}-${suffix}`;
}
