import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEvent, type WorkgraphEvent, type WorkgraphEventInput } from "./schema.js";

export type OutboxEventInput = WorkgraphEventInput;

export type TimelineEntry = WorkgraphEvent & {
  sequence: number;
  deliveryAttempts: number;
  deliveredAt?: string;
  lastDeliveryError?: string;
  claimedBy?: string;
  claimExpiresAt?: number;
};

export class WorkgraphOutbox {
  readonly #db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    // Set the lock wait before negotiating WAL or creating the shared schema.
    this.#db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS workgraph_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        initiative_id TEXT NOT NULL,
        initiative_identifier TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        run_id TEXT,
        agent_id TEXT,
        event_type TEXT NOT NULL,
        bounded_summary TEXT NOT NULL,
        source TEXT NOT NULL,
        source_revision TEXT,
        authority TEXT NOT NULL,
        node_sets_json TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        extraction_prompt_version TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        memory_record_json TEXT,
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        delivered_at TEXT,
        last_delivery_error TEXT,
        claimed_by TEXT,
        claim_expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS workgraph_events_initiative_timeline
        ON workgraph_events (initiative_id, timestamp, sequence);
      CREATE INDEX IF NOT EXISTS workgraph_events_workspace_pending
        ON workgraph_events (workspace_id, delivered_at, sequence)
        WHERE memory_record_json IS NOT NULL;
    `);
  }

  append(input: OutboxEventInput): TimelineEntry {
    if (!input.workspaceId.trim()) throw new Error("workspaceId is required");
    const event = createEvent(input) as WorkgraphEvent & OutboxEventInput;
    this.#db.prepare(`
      INSERT OR IGNORE INTO workgraph_events (
        event_id, timestamp, workspace_id, initiative_id, initiative_identifier,
        issue_id, project_id, task_id, run_id, agent_id, event_type,
        bounded_summary, source, source_revision, authority, node_sets_json,
        schema_version, extraction_prompt_version, payload_hash, memory_record_json
      ) VALUES (
        @eventId, @timestamp, @workspaceId, @initiativeId, @initiativeIdentifier,
        @issueId, @projectId, @taskId, @runId, @agentId, @eventType,
        @boundedSummary, @source, @sourceRevision, @authority, @nodeSetsJson,
        @schemaVersion, @extractionPromptVersion, @payloadHash, @memoryRecordJson
      )
    `).run({
      eventId: event.eventId,
      timestamp: event.timestamp,
      workspaceId: event.workspaceId,
      initiativeId: event.initiativeId,
      initiativeIdentifier: event.initiativeIdentifier,
      issueId: event.issueId,
      projectId: event.projectId ?? null,
      taskId: event.taskId ?? null,
      runId: event.runId ?? null,
      agentId: event.agentId ?? null,
      eventType: event.eventType,
      boundedSummary: event.boundedSummary,
      source: event.source,
      sourceRevision: event.sourceRevision ?? null,
      authority: event.authority,
      nodeSetsJson: JSON.stringify(event.nodeSets),
      schemaVersion: event.schemaVersion,
      extractionPromptVersion: event.extractionPromptVersion,
      payloadHash: event.payloadHash,
      memoryRecordJson: event.memoryRecord ? JSON.stringify(event.memoryRecord) : null,
    });
    return this.get(event.eventId);
  }

  get(eventId: string): TimelineEntry {
    const row = this.#db.prepare("SELECT * FROM workgraph_events WHERE event_id = ?").get(eventId);
    if (!row) throw new Error(`Unknown workgraph event: ${eventId}`);
    return mapRow(row as Record<string, unknown>);
  }

  pending(workspaceId: string, limit = 50): TimelineEntry[] {
    const bounded = boundLimit(limit);
    return (this.#db.prepare(`
      SELECT * FROM workgraph_events
      WHERE workspace_id = ? AND memory_record_json IS NOT NULL AND delivered_at IS NULL
      ORDER BY sequence ASC LIMIT ?
    `).all(workspaceId, bounded) as Record<string, unknown>[]).map(mapRow);
  }

  claimPending(workspaceId: string, owner: string, limit = 50, leaseMs = 30_000): TimelineEntry[] {
    if (!workspaceId.trim()) throw new Error("workspaceId is required");
    if (!owner.trim()) throw new Error("claim owner is required");
    const now = Date.now();
    const expiresAt = now + Math.max(1, Math.trunc(leaseMs));
    const rows = this.#db.prepare(`
      WITH claimable AS (
        SELECT sequence FROM workgraph_events
        WHERE workspace_id = ? AND memory_record_json IS NOT NULL AND delivered_at IS NULL
          AND (claimed_by IS NULL OR claim_expires_at <= ?)
        ORDER BY sequence ASC LIMIT ?
      )
      UPDATE workgraph_events SET claimed_by = ?, claim_expires_at = ?
      WHERE sequence IN (SELECT sequence FROM claimable)
      RETURNING *
    `).all(workspaceId, now, boundLimit(limit), owner, expiresAt) as Record<string, unknown>[];
    return rows.map(mapRow).sort((left, right) => left.sequence - right.sequence);
  }

  timeline(initiativeId: string, limit = 100): TimelineEntry[] {
    const bounded = boundLimit(limit);
    return (this.#db.prepare(`
      SELECT * FROM workgraph_events WHERE initiative_id = ?
      ORDER BY timestamp DESC, sequence DESC LIMIT ?
    `).all(initiativeId, bounded) as Record<string, unknown>[]).map(mapRow).reverse();
  }

  markDelivered(eventId: string, owner?: string, deliveredAt = new Date().toISOString()): boolean {
    const result = owner === undefined
      ? this.#db.prepare(`
          UPDATE workgraph_events SET delivery_attempts = delivery_attempts + 1,
          delivered_at = ?, last_delivery_error = NULL, claimed_by = NULL, claim_expires_at = NULL
          WHERE event_id = ? AND delivered_at IS NULL
        `).run(deliveredAt, eventId)
      : this.#db.prepare(`
          UPDATE workgraph_events SET delivery_attempts = delivery_attempts + 1,
          delivered_at = ?, last_delivery_error = NULL, claimed_by = NULL, claim_expires_at = NULL
          WHERE event_id = ? AND delivered_at IS NULL AND claimed_by = ? AND claim_expires_at > ?
        `).run(deliveredAt, eventId, owner, Date.now());
    return Number(result.changes) === 1;
  }

  markFailed(eventId: string, error: string, owner?: string): boolean {
    const parameters = [error.slice(0, 1000), eventId];
    const result = owner === undefined
      ? this.#db.prepare(`
          UPDATE workgraph_events SET delivery_attempts = delivery_attempts + 1,
          last_delivery_error = ?, claimed_by = NULL, claim_expires_at = NULL
          WHERE event_id = ? AND delivered_at IS NULL
        `).run(...parameters)
      : this.#db.prepare(`
          UPDATE workgraph_events SET delivery_attempts = delivery_attempts + 1,
          last_delivery_error = ?, claimed_by = NULL, claim_expires_at = NULL
          WHERE event_id = ? AND delivered_at IS NULL AND claimed_by = ? AND claim_expires_at > ?
        `).run(...parameters, owner, Date.now());
    return Number(result.changes) === 1;
  }

  close(): void { this.#db.close(); }
}

function mapRow(row: Record<string, unknown>): TimelineEntry {
  return {
    sequence: Number(row.sequence),
    eventId: String(row.event_id),
    timestamp: String(row.timestamp),
    workspaceId: String(row.workspace_id),
    initiativeId: String(row.initiative_id),
    initiativeIdentifier: String(row.initiative_identifier),
    issueId: String(row.issue_id),
    projectId: stringOrUndefined(row.project_id),
    taskId: stringOrUndefined(row.task_id),
    runId: stringOrUndefined(row.run_id),
    agentId: stringOrUndefined(row.agent_id),
    eventType: row.event_type as TimelineEntry["eventType"],
    boundedSummary: String(row.bounded_summary),
    source: String(row.source),
    sourceRevision: stringOrUndefined(row.source_revision),
    authority: row.authority as TimelineEntry["authority"],
    nodeSets: JSON.parse(String(row.node_sets_json)) as string[],
    schemaVersion: String(row.schema_version),
    extractionPromptVersion: String(row.extraction_prompt_version),
    payloadHash: String(row.payload_hash),
    memoryRecord: typeof row.memory_record_json === "string" ? JSON.parse(row.memory_record_json) : undefined,
    deliveryAttempts: Number(row.delivery_attempts),
    deliveredAt: stringOrUndefined(row.delivered_at),
    lastDeliveryError: stringOrUndefined(row.last_delivery_error),
    claimedBy: stringOrUndefined(row.claimed_by),
    claimExpiresAt: numberOrUndefined(row.claim_expires_at),
  };
}

function boundLimit(limit: number): number {
  return Math.max(1, Math.min(500, Math.trunc(limit)));
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" || typeof value === "bigint" ? Number(value) : undefined;
}
