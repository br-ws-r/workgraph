import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CogneeApiClient, createCogneeClientFromEnv } from "./cognee.js";
import { MulticaReader, type InitiativeResolution } from "./multica.js";
import { WorkgraphOutbox, type TimelineEntry } from "./outbox.js";
import {
  MemoryRecordSchema, boundText, datasetForInitiative, type Authority,
  type EdgeType, type EventType, type MemoryRecord, type NodeType,
} from "./schema.js";

export interface WorkgraphScope {
  workspaceId?: string;
  initiativeId: string;
  dataset: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  issueId: string;
  rootTitle?: string;
}

export interface WorkgraphRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  outbox?: WorkgraphOutbox;
  cognee?: CogneeApiClient;
  multica?: MulticaReader;
}

export class WorkgraphRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly outbox: WorkgraphOutbox;
  readonly cognee?: CogneeApiClient;
  readonly multica: MulticaReader;
  #scope?: WorkgraphScope;
  #writes = Promise.resolve<unknown>(undefined);

  constructor(options: WorkgraphRuntimeOptions = {}) {
    this.env = options.env ?? process.env;
    const dataDir = this.env.WORKGRAPH_DATA_DIR?.trim() || "/srv/data/cognee/outbox";
    this.outbox = options.outbox ?? new WorkgraphOutbox(join(dataDir, "brwsr.db"));
    this.cognee = options.cognee ?? createCogneeClientFromEnv(this.env);
    this.multica = options.multica ?? new MulticaReader({ binary: this.env.MULTICA_BIN?.trim() || "multica" });
  }

  get scope(): Readonly<WorkgraphScope> | undefined { return this.#scope; }

  lockInitiative(resolution: InitiativeResolution): WorkgraphScope {
    if (this.#scope) throw new Error("Workgraph initiative is immutable for the lifetime of this Pi process");
    const initiativeId = resolution.root.id.toLowerCase();
    this.#scope = Object.freeze({
      workspaceId: this.env.MULTICA_WORKSPACE_ID?.trim(),
      initiativeId,
      dataset: datasetForInitiative(initiativeId),
      taskId: this.env.MULTICA_TASK_ID?.trim() || resolution.taskId,
      runId: this.env.MULTICA_RUN_ID?.trim(),
      agentId: this.env.MULTICA_AGENT_ID?.trim(),
      issueId: resolution.issue.id,
      rootTitle: resolution.root.title,
    });
    this.append("initiative_selected", `Selected initiative ${resolution.root.title ?? initiativeId}.`, "multica://initiative-resolution", "confirmed");
    this.append("run_started", `Run ${this.#scope.runId ?? "interactive"} started for issue ${this.#scope.issueId}.`, this.issueSource(), "observed");
    return this.#scope;
  }

  append(eventType: EventType, summary: string, source: string, authority: Authority, memoryRecord?: MemoryRecord): TimelineEntry | undefined {
    if (!this.#scope) return undefined;
    return this.outbox.append({
      workspaceId: this.#scope.workspaceId,
      initiativeId: this.#scope.initiativeId,
      taskId: this.#scope.taskId,
      runId: this.#scope.runId,
      agentId: this.#scope.agentId,
      eventType,
      boundedSummary: boundText(summary, 4000),
      source,
      authority,
      memoryRecord,
    });
  }

  async refreshIssue(): Promise<InitiativeResolution | undefined> {
    if (!this.#scope) return undefined;
    const resolution = await this.multica.resolveIssue(this.#scope.issueId, this.#scope.workspaceId);
    if (resolution.root.id.toLowerCase() !== this.#scope.initiativeId) {
      throw new Error("Authoritative Multica root changed during an immutable Workgraph process");
    }
    return resolution;
  }

  async recall(query: string, topK = 8, signal?: AbortSignal): Promise<unknown> {
    if (!this.#scope || !this.cognee) return undefined;
    const result = await this.cognee.recall(boundText(query, 2000), this.#scope.dataset, Math.min(20, Math.max(1, topK)), signal);
    this.append("context_recalled", `Recalled initiative-scoped context for: ${boundText(query, 300)}`, "cognee://search", "inferred");
    return result;
  }

  remember(input: {
    entityType: NodeType;
    authority: Authority;
    summary: string;
    source: string;
    sourceRevision?: string;
    relations?: Array<{ type: EdgeType; target: string }>;
    entityId?: string;
    eventType?: EventType;
  }): TimelineEntry {
    if (!this.#scope) throw new Error("No initiative is selected; memory writes are disabled");
    const record = MemoryRecordSchema.parse({
      entity_type: input.entityType,
      authority: input.authority,
      initiative_id: this.#scope.initiativeId,
      entity_id: input.entityId ?? `${input.entityType.toLowerCase()}:${randomUUID()}`,
      summary: boundText(input.summary, 4000),
      relations: input.relations ?? [{ type: "about", target: `issue:${this.#scope.initiativeId}` }],
      source: input.source,
      source_revision: input.sourceRevision,
      observed_at: new Date().toISOString(),
    });
    const eventType = input.eventType ?? (input.entityType === "Decision" ? "decision_recorded" : input.entityType === "Blocker" ? "blocker_recorded" : "evidence_recorded");
    const event = this.append(eventType, record.summary, record.source, record.authority, record);
    if (!event) throw new Error("No initiative is selected; memory writes are disabled");
    this.scheduleFlush();
    return event;
  }

  scheduleFlush(): void {
    this.#writes = this.#writes.then(() => this.flush(25, 3000)).catch(() => undefined);
  }

  async flush(limit = 25, timeoutMs = 3000): Promise<{ delivered: number; failed: number }> {
    if (!this.#scope || !this.cognee) return { delivered: 0, failed: 0 };
    const deadline = Date.now() + timeoutMs;
    let delivered = 0;
    let failed = 0;
    for (const event of this.outbox.pending(limit)) {
      if (Date.now() >= deadline) break;
      if (event.initiativeId !== this.#scope.initiativeId || !event.memoryRecord) continue;
      try {
        await this.cognee.remember(event.memoryRecord, this.#scope.dataset, event.payloadHash, AbortSignal.timeout(Math.max(100, deadline - Date.now())));
        this.outbox.markDelivered(event.eventId);
        this.append("memory_delivery_succeeded", `Delivered event ${event.eventId} to Cognee.`, `cognee://datasets/${this.#scope.dataset}`, "observed");
        delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.outbox.markFailed(event.eventId, message);
        this.append("memory_delivery_failed", `Delivery failed for event ${event.eventId}: ${boundText(message, 500)}`, `cognee://datasets/${this.#scope.dataset}`, "observed");
        failed += 1;
      }
    }
    return { delivered, failed };
  }

  timeline(limit = 100): TimelineEntry[] {
    return this.#scope ? this.outbox.timeline(this.#scope.initiativeId, limit) : [];
  }

  async shutdown(): Promise<void> {
    await Promise.race([this.#writes, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await this.flush(25, 2000).catch(() => undefined);
    this.outbox.close();
  }

  issueSource(): string {
    return this.#scope ? `multica://issues/${this.#scope.issueId}` : "multica://unscoped";
  }
}
