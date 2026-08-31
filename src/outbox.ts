import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEvent, type WorkgraphEvent, type WorkgraphEventInput } from "./schema.js";

export interface TimelineEntry extends WorkgraphEvent {
  sequence: number;
  deliveryAttempts: number;
  deliveredAt?: string;
  lastDeliveryError?: string;
}

export class WorkgraphOutbox {
  readonly #db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS workgraph_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        workspace_id TEXT,
        initiative_id TEXT NOT NULL,
        task_id TEXT,
        run_id TEXT,
        agent_id TEXT,
        event_type TEXT NOT NULL,
        bounded_summary TEXT NOT NULL,
        source TEXT NOT NULL,
        source_revision TEXT,
        authority TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        memory_record_json TEXT,
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        delivered_at TEXT,
        last_delivery_error TEXT
      );
      CREATE INDEX IF NOT EXISTS workgraph_events_initiative_timeline
        ON workgraph_events (initiative_id, timestamp, sequence);
      CREATE INDEX IF NOT EXISTS workgraph_events_pending_delivery
        ON workgraph_events (delivered_at, sequence)
        WHERE memory_record_json IS NOT NULL;
    `);
  }

  append(input: WorkgraphEventInput): TimelineEntry {
    const event = createEvent(input);
    this.#db.prepare(`
      INSERT OR IGNORE INTO workgraph_events (
        event_id, timestamp, workspace_id, initiative_id, task_id, run_id,
        agent_id, event_type, bounded_summary, source, source_revision,
        authority, payload_hash, memory_record_json
      ) VALUES (
        @eventId, @timestamp, @workspaceId, @initiativeId, @taskId, @runId,
        @agentId, @eventType, @boundedSummary, @source, @sourceRevision,
        @authority, @payloadHash, @memoryRecordJson
      )
    `).run({
      eventId: event.eventId,
      timestamp: event.timestamp,
      workspaceId: event.workspaceId ?? null,
      initiativeId: event.initiativeId,
      taskId: event.taskId ?? null,
      runId: event.runId ?? null,
      agentId: event.agentId ?? null,
      eventType: event.eventType,
      boundedSummary: event.boundedSummary,
      source: event.source,
      sourceRevision: event.sourceRevision ?? null,
      authority: event.authority,
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

  pending(limit = 50): TimelineEntry[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    return (this.#db.prepare(`
      SELECT * FROM workgraph_events
      WHERE memory_record_json IS NOT NULL AND delivered_at IS NULL
      ORDER BY sequence ASC LIMIT ?
    `).all(bounded) as Record<string, unknown>[]).map(mapRow);
  }

  timeline(initiativeId: string, limit = 100): TimelineEntry[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    return (this.#db.prepare(`
      SELECT * FROM workgraph_events WHERE initiative_id = ?
      ORDER BY timestamp DESC, sequence DESC LIMIT ?
    `).all(initiativeId, bounded) as Record<string, unknown>[]).map(mapRow).reverse();
  }

  markDelivered(eventId: string, deliveredAt = new Date().toISOString()): void {
    this.#db.prepare(`
      UPDATE workgraph_events SET delivery_attempts = delivery_attempts + 1,
      delivered_at = ?, last_delivery_error = NULL WHERE event_id = ?
    `).run(deliveredAt, eventId);
  }

  markFailed(eventId: string, error: string): void {
    this.#db.prepare(`
      UPDATE workgraph_events SET delivery_attempts = delivery_attempts + 1,
      last_delivery_error = ? WHERE event_id = ?
    `).run(error.slice(0, 1000), eventId);
  }

  close(): void { this.#db.close(); }
}

function mapRow(row: Record<string, unknown>): TimelineEntry {
  return {
    sequence: Number(row.sequence),
    eventId: String(row.event_id),
    timestamp: String(row.timestamp),
    workspaceId: stringOrUndefined(row.workspace_id),
    initiativeId: String(row.initiative_id),
    taskId: stringOrUndefined(row.task_id),
    runId: stringOrUndefined(row.run_id),
    agentId: stringOrUndefined(row.agent_id),
    eventType: row.event_type as TimelineEntry["eventType"],
    boundedSummary: String(row.bounded_summary),
    source: String(row.source),
    sourceRevision: stringOrUndefined(row.source_revision),
    authority: row.authority as TimelineEntry["authority"],
    payloadHash: String(row.payload_hash),
    memoryRecord: typeof row.memory_record_json === "string" ? JSON.parse(row.memory_record_json) : undefined,
    deliveryAttempts: Number(row.delivery_attempts),
    deliveredAt: stringOrUndefined(row.delivered_at),
    lastDeliveryError: stringOrUndefined(row.last_delivery_error),
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
