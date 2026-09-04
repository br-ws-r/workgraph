import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { CogneeApiClient, createCogneeClientFromEnv, type CogneeRecallEntry } from "./cognee.js";
import { MulticaReader, type InitiativeResolution } from "./multica.js";
import { WorkgraphOutbox, type TimelineEntry } from "./outbox.js";
import {
  EXTRACTION_PROMPT_VERSION,
  MemoryRecordSchema,
  SCHEMA_VERSION,
  boundText,
  datasetForWorkspace,
  deriveNodeSets,
  initiativeNodeSet,
  type Authority,
  type EdgeType,
  type EventType,
  type MemoryRecord,
  type NodeType,
} from "./schema.js";

export type RecallScope = "initiative" | "workspace" | "both";

export interface WorkgraphScope {
  workspaceId: string;
  initiativeId: string;
  initiativeIdentifier: string;
  dataset: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  issueId: string;
  projectId?: string;
  parentIssueId?: string;
  stage?: number;
  rootTitle?: string;
}

export interface RecalledMemory {
  workspaceId: string;
  initiativeId: string;
  initiativeIdentifier: string;
  entityType: NodeType;
  entityId: string;
  authority: Authority;
  summary: string;
  source: string;
  sourceRevision?: string;
  observedAt: string;
}

export interface WorkgraphRecall {
  initiative?: RecalledMemory[];
  workspace?: RecalledMemory[];
}

export interface WorkgraphContext {
  resolution: InitiativeResolution;
  memory: WorkgraphRecall;
  memoryError?: string;
}

export interface WorkgraphRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  outbox?: WorkgraphOutbox;
  cognee?: CogneeApiClient;
  multica?: MulticaReader;
}

export interface RememberInput {
  entityType: NodeType;
  authority: Authority;
  summary: string;
  source: string;
  sourceRevision?: string;
  relations?: Array<{ type: EdgeType; target: string }>;
  entityId?: string;
  eventType?: EventType;
}

export class WorkgraphRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly outbox: WorkgraphOutbox;
  readonly cognee?: CogneeApiClient;
  readonly multica: MulticaReader;
  readonly #flushOwner = randomUUID();
  readonly #deliveryTimeoutMs: number;
  #scope?: WorkgraphScope;
  #writes = Promise.resolve<unknown>(undefined);
  #closing = false;
  #shutdown?: Promise<void>;

  constructor(options: WorkgraphRuntimeOptions = {}) {
    this.env = options.env ?? process.env;
    const userDataDir = this.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
    const dataDir = this.env.WORKGRAPH_DATA_DIR?.trim() || join(userDataDir, "workgraph");
    this.outbox = options.outbox ?? new WorkgraphOutbox(join(dataDir, "workgraph-workspace.db"));
    this.cognee = options.cognee ?? createCogneeClientFromEnv(this.env);
    this.multica = options.multica ?? new MulticaReader({ binary: this.env.MULTICA_BIN?.trim() || "multica" });
    const configuredDeliveryTimeout = Number(this.env.WORKGRAPH_COGNEE_REMEMBER_TIMEOUT_MS ?? "120000");
    this.#deliveryTimeoutMs = Number.isFinite(configuredDeliveryTimeout) && configuredDeliveryTimeout >= 100
      ? Math.trunc(configuredDeliveryTimeout)
      : 120_000;
  }

  get scope(): Readonly<WorkgraphScope> | undefined { return this.#scope; }

  lockInitiative(resolution: InitiativeResolution): WorkgraphScope {
    if (this.#scope) throw new Error("Workgraph scope is immutable for the lifetime of this Pi process");
    const workspaceId = requiredValue(this.env.MULTICA_WORKSPACE_ID, "MULTICA_WORKSPACE_ID").toLowerCase();
    if (resolution.issue.workspace_id.toLowerCase() !== workspaceId || resolution.root.workspace_id.toLowerCase() !== workspaceId) {
      throw new Error("Multica resolution does not belong to the configured workspace");
    }
    const initiativeId = resolution.root.id.toLowerCase();
    const initiativeIdentifier = requiredValue(resolution.root.identifier, "Multica root identifier");
    const taskId = resolution.taskId;
    const nextScope = Object.freeze({
      workspaceId,
      initiativeId,
      initiativeIdentifier,
      dataset: datasetForWorkspace(workspaceId),
      taskId,
      runId: this.env.MULTICA_RUN_ID?.trim() || taskId,
      agentId: this.env.MULTICA_AGENT_ID?.trim(),
      issueId: resolution.issue.id.toLowerCase(),
      projectId: resolution.issue.project_id?.toLowerCase() || undefined,
      parentIssueId: resolution.issue.parent_issue_id?.toLowerCase() || undefined,
      stage: resolution.issue.stage ?? undefined,
      rootTitle: resolution.root.title,
    });
    deriveNodeSets({
      initiativeIdentifier,
      entityType: "Run",
      authority: "observed",
      projectId: nextScope.projectId,
      parentIssueId: nextScope.parentIssueId,
      stage: nextScope.stage,
    });
    this.#scope = nextScope;
    try {
      this.append(
        "initiative_selected",
        `Selected initiative ${initiativeIdentifier}${resolution.root.title ? `: ${resolution.root.title}` : ""}.`,
        "multica://initiative-resolution",
        "confirmed",
      );
      this.append(
        "run_started",
        `Run ${nextScope.runId ?? "interactive"} started for issue ${nextScope.issueId}.`,
        this.issueSource(),
        "observed",
      );
      return nextScope;
    } catch (error) {
      this.#scope = undefined;
      throw error;
    }
  }

  append(
    eventType: EventType,
    summary: string,
    source: string,
    authority: Authority,
    memoryRecord?: MemoryRecord,
  ): TimelineEntry | undefined {
    if (!this.#scope) return undefined;
    const nodeSets = memoryRecord?.node_sets ?? deriveNodeSets({
      initiativeIdentifier: this.#scope.initiativeIdentifier,
      entityType: eventType === "initiative_selected" ? "Initiative" : "Run",
      authority,
      projectId: this.#scope.projectId,
      parentIssueId: this.#scope.parentIssueId,
      stage: this.#scope.stage,
    });
    return this.outbox.append({
      workspaceId: this.#scope.workspaceId,
      initiativeId: this.#scope.initiativeId,
      initiativeIdentifier: this.#scope.initiativeIdentifier,
      issueId: this.#scope.issueId,
      projectId: this.#scope.projectId,
      taskId: this.#scope.taskId,
      runId: this.#scope.runId,
      agentId: this.#scope.agentId,
      eventType,
      boundedSummary: boundText(summary, 4000),
      source,
      sourceRevision: memoryRecord?.source_revision,
      authority,
      nodeSets,
      schemaVersion: SCHEMA_VERSION,
      extractionPromptVersion: EXTRACTION_PROMPT_VERSION,
      memoryRecord,
    });
  }

  async refreshIssue(): Promise<InitiativeResolution | undefined> {
    if (!this.#scope) return undefined;
    const resolution = this.#scope.taskId && this.#scope.agentId
      ? await this.multica.resolveTask(this.#scope.taskId, this.#scope.agentId, this.#scope.workspaceId)
      : await this.multica.resolveIssue(this.#scope.issueId, this.#scope.workspaceId);
    if (resolution.root.id.toLowerCase() !== this.#scope.initiativeId
      || resolution.root.identifier !== this.#scope.initiativeIdentifier) {
      throw new Error("Authoritative Multica root changed during an immutable Workgraph process");
    }
    return resolution;
  }

  async context(query: string, signal?: AbortSignal): Promise<WorkgraphContext> {
    const resolution = await this.requireFreshResolution();
    try {
      return { resolution, memory: await this.recallVerified(query, "both", 8, signal) };
    } catch (error) {
      return {
        resolution,
        memory: {},
        memoryError: boundText(error instanceof Error ? error.message : String(error), 500),
      };
    }
  }

  async recall(
    query: string,
    scope: RecallScope = "initiative",
    topK = 8,
    signal?: AbortSignal,
  ): Promise<WorkgraphRecall> {
    await this.requireFreshResolution();
    return this.recallVerified(query, scope, topK, signal);
  }

  async remember(input: RememberInput): Promise<TimelineEntry> {
    return this.rememberVerified(input, await this.requireFreshResolution());
  }

  async settle(): Promise<TimelineEntry> {
    const resolution = await this.requireFreshResolution();
    const scope = this.#scope!;
    return this.rememberVerified({
      entityType: "Outcome",
      authority: "observed",
      summary: `Run ${scope.runId ?? "interactive"} settled. Multica issue ${resolution.issue.title ?? resolution.issue.identifier} is ${resolution.issue.status}.`,
      source: this.issueSource(),
      entityId: `run:${scope.runId ?? scope.issueId}:outcome`,
      relations: [{ type: "observed_in", target: `issue:${scope.issueId}` }],
      eventType: "run_settled",
    }, resolution);
  }

  async compact(): Promise<TimelineEntry> {
    const resolution = await this.requireFreshResolution();
    const scope = this.#scope!;
    return this.rememberVerified({
      entityType: "Run",
      authority: "observed",
      summary: `Compaction anchor for issue ${resolution.issue.title ?? resolution.issue.identifier}; authoritative status ${resolution.issue.status}. Consult the Workgraph timeline for durable decisions, blockers, artifacts, evidence, and outcomes.`,
      source: this.issueSource(),
      entityId: `run:${scope.runId ?? scope.issueId}:compaction:${Date.now()}`,
      eventType: "compaction_anchor",
    }, resolution);
  }

  scheduleFlush(): void {
    if (this.#closing) return;
    void this.flush(25, this.#deliveryTimeoutMs).catch(() => undefined);
  }

  async flush(limit = 25, timeoutMs = this.#deliveryTimeoutMs): Promise<{ delivered: number; failed: number }> {
    if (this.#closing) return { delivered: 0, failed: 0 };
    const operation = this.#writes.then(() => this.flushNow(limit, timeoutMs));
    this.#writes = operation.catch(() => undefined);
    return operation;
  }

  private async flushNow(limit: number, timeoutMs: number): Promise<{ delivered: number; failed: number }> {
    if (!this.#scope || !this.cognee) return { delivered: 0, failed: 0 };
    const deadline = Date.now() + timeoutMs;
    let delivered = 0;
    let failed = 0;
    const events = this.outbox.claimPending(
      this.#scope.workspaceId,
      this.#flushOwner,
      limit,
      timeoutMs + 1000,
    );
    for (const event of events) {
      if (Date.now() >= deadline) break;
      if (!event.memoryRecord) continue;
      try {
        await this.cognee.remember(
          event.memoryRecord,
          this.#scope.dataset,
          event.payloadHash,
          AbortSignal.timeout(Math.max(100, deadline - Date.now())),
        );
        if (this.outbox.markDelivered(event.eventId, this.#flushOwner)) {
          delivered += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.outbox.markFailed(event.eventId, message, this.#flushOwner)) {
          failed += 1;
        }
      }
    }
    return { delivered, failed };
  }

  timeline(limit = 100): TimelineEntry[] {
    return this.#scope ? this.outbox.timeline(this.#scope.initiativeId, limit) : [];
  }

  pendingCount(limit = 500): number {
    return this.#scope ? this.outbox.pending(this.#scope.workspaceId, limit).length : 0;
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#closing = true;
    const finalFlush = this.#writes.then(() => this.flushNow(25, this.#deliveryTimeoutMs));
    this.#writes = finalFlush.catch(() => undefined);
    this.#shutdown = this.#writes.then(() => { this.outbox.close(); });
    return this.#shutdown;
  }

  issueSource(): string {
    return this.#scope ? `multica://issues/${this.#scope.issueId}` : "multica://unscoped";
  }

  async requireFreshResolution(): Promise<InitiativeResolution> {
    if (!this.#scope) throw new Error("No initiative is selected; memory is disabled");
    const resolution = await this.refreshIssue();
    if (!resolution) throw new Error("No initiative is selected; memory is disabled");
    return resolution;
  }

  private async recallVerified(
    query: string,
    scope: RecallScope,
    topK: number,
    signal?: AbortSignal,
  ): Promise<WorkgraphRecall> {
    if (!this.#scope || !this.cognee) return {};
    const boundedQuery = boundText(query, 2000);
    const boundedTopK = Math.min(20, Math.max(1, Math.trunc(topK)));
    const activeInitiativeNodeSet = initiativeNodeSet(this.#scope.initiativeIdentifier);
    const result: WorkgraphRecall = {};
    if (scope === "initiative" || scope === "both") {
      const entries = await this.cognee.recall(boundedQuery, this.#scope.dataset, {
        topK: boundedTopK,
        nodeNames: [activeInitiativeNodeSet],
        signal,
      });
      result.initiative = normalizeMemories(entries)
        .filter((record) => record.workspaceId === this.#scope!.workspaceId
          && record.initiativeId === this.#scope!.initiativeId
          && record.initiativeIdentifier === this.#scope!.initiativeIdentifier);
    }
    if (scope === "workspace" || scope === "both") {
      const entries = await this.cognee.recall(boundedQuery, this.#scope.dataset, {
        topK: scope === "both" ? Math.min(20, Math.max(12, boundedTopK * 3)) : boundedTopK,
        signal,
      });
      result.workspace = normalizeMemories(entries)
        .filter((record) => record.workspaceId === this.#scope!.workspaceId
          && record.initiativeId !== this.#scope!.initiativeId)
        .slice(0, scope === "both" ? 4 : boundedTopK);
    }
    this.append("context_recalled", `Recalled ${scope} context for: ${boundText(query, 300)}`, "cognee://recall", "inferred");
    return result;
  }

  private rememberVerified(input: RememberInput, resolution: InitiativeResolution): TimelineEntry {
    if (!this.#scope) throw new Error("No initiative is selected; memory writes are disabled");
    const issue = resolution.issue;
    const nodeSets = deriveNodeSets({
      initiativeIdentifier: this.#scope.initiativeIdentifier,
      entityType: input.entityType,
      authority: input.authority,
      projectId: issue.project_id,
      parentIssueId: issue.parent_issue_id,
      stage: issue.stage,
    });
    const record = MemoryRecordSchema.parse({
      schema_version: SCHEMA_VERSION,
      extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
      workspace_id: this.#scope.workspaceId,
      initiative_id: this.#scope.initiativeId,
      initiative_identifier: this.#scope.initiativeIdentifier,
      issue_id: issue.id,
      project_id: issue.project_id,
      parent_issue_id: issue.parent_issue_id,
      stage: issue.stage,
      entity_type: input.entityType,
      authority: input.authority,
      entity_id: input.entityId ?? `${input.entityType.toLowerCase()}:${randomUUID()}`,
      summary: boundText(input.summary, 4000),
      relations: input.relations ?? [{ type: "about", target: `issue:${this.#scope.initiativeId}` }],
      node_sets: nodeSets,
      source: input.source,
      source_revision: input.sourceRevision,
      observed_at: new Date().toISOString(),
    });
    const eventType = input.eventType
      ?? (input.entityType === "Decision" ? "decision_recorded"
        : input.entityType === "Blocker" ? "blocker_recorded"
          : input.entityType === "Artifact" ? "artifact_observed"
            : input.entityType === "Handoff" ? "handoff_observed"
              : "evidence_recorded");
    const event = this.append(eventType, record.summary, record.source, record.authority, record);
    if (!event) throw new Error("No initiative is selected; memory writes are disabled");
    this.scheduleFlush();
    return event;
  }
}

function normalizeMemories(entries: CogneeRecallEntry[]): RecalledMemory[] {
  const memories: RecalledMemory[] = [];
  for (const entry of entries) {
    const record = parseMemoryRecord(entry.text);
    if (!record) continue;
    memories.push({
      workspaceId: record.workspace_id,
      initiativeId: record.initiative_id,
      initiativeIdentifier: record.initiative_identifier,
      entityType: record.entity_type,
      entityId: record.entity_id,
      authority: record.authority,
      summary: record.summary,
      source: record.source,
      sourceRevision: record.source_revision,
      observedAt: record.observed_at,
    });
  }
  return memories;
}

function parseMemoryRecord(text: string): MemoryRecord | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = MemoryRecordSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function requiredValue(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}
