import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { CogneeApiClient, createCogneeClientFromEnv, type CogneeRecallEntry } from "./cognee.js";
import { MulticaReader, type InitiativeResolution, type MulticaActivity } from "./multica.js";
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
  workspaceIdentifier: string;
  workspaceName: string;
  initiativeId: string;
  initiativeIdentifier: string;
  dataset: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  issueId: string;
  issueIdentifier: string;
  projectId?: string;
  projectIdentifier?: string;
  parentIssueId?: string;
  parentIssueIdentifier?: string;
  stage?: number;
  rootTitle?: string;
}

export interface RecalledMemory {
  workspaceId: string;
  initiativeId: string;
  initiativeIdentifier: string;
  entityType: NodeType;
  entityIdentifier: string;
  entityLabel: string;
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
  entityIdentifier?: string;
  entityLabel?: string;
  eventType?: EventType;
  eventId?: string;
  observedAt?: string;
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
  #reconciliations = Promise.resolve<unknown>(undefined);
  #closing = false;
  #shutdown?: Promise<void>;

  constructor(options: WorkgraphRuntimeOptions = {}) {
    this.env = options.env ?? process.env;
    const userDataDir = this.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
    const dataDir = this.env.WORKGRAPH_DATA_DIR?.trim() || join(userDataDir, "workgraph");
    this.outbox = options.outbox ?? new WorkgraphOutbox(join(dataDir, "workgraph-workspace-v3.db"));
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
    const workspaceId = this.env.MULTICA_WORKSPACE_ID?.trim().toLowerCase()
      || resolution.workspace.id.toLowerCase();
    if (resolution.workspace.id.toLowerCase() !== workspaceId
      || resolution.issue.workspace_id.toLowerCase() !== workspaceId
      || resolution.root.workspace_id.toLowerCase() !== workspaceId) {
      throw new Error("Multica resolution does not belong to the configured workspace");
    }
    validateResolutionLinks(resolution);
    const initiativeId = resolution.root.id.toLowerCase();
    const initiativeIdentifier = requiredValue(resolution.root.identifier, "Multica root identifier");
    const taskId = resolution.taskId;
    const nextScope = Object.freeze({
      workspaceId,
      workspaceIdentifier: resolution.workspace.slug,
      workspaceName: resolution.workspace.name,
      initiativeId,
      initiativeIdentifier,
      dataset: datasetForWorkspace(resolution.workspace.slug),
      taskId,
      runId: this.env.MULTICA_RUN_ID?.trim() || taskId,
      agentId: this.env.MULTICA_AGENT_ID?.trim(),
      issueId: resolution.issue.id.toLowerCase(),
      issueIdentifier: requiredValue(resolution.issue.identifier, "Multica issue identifier"),
      projectId: resolution.issue.project_id?.toLowerCase() || undefined,
      projectIdentifier: resolution.project
        ? projectIdentifier(resolution.project.title, resolution.project.id)
        : undefined,
      parentIssueId: resolution.issue.parent_issue_id?.toLowerCase() || undefined,
      parentIssueIdentifier: resolution.issue.parent_issue_id ? resolution.parent?.identifier : undefined,
      stage: resolution.issue.stage ?? undefined,
      rootTitle: resolution.root.title,
    });
    deriveNodeSets({
      initiativeIdentifier,
      entityType: "Run",
      authority: "observed",
      projectIdentifier: nextScope.projectIdentifier,
      parentIssueIdentifier: nextScope.parentIssueIdentifier,
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
        `${nextScope.runId ? "Managed" : "Interactive"} run started for issue ${nextScope.issueIdentifier}.`,
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
    identity?: { eventId?: string; timestamp?: string },
  ): TimelineEntry | undefined {
    if (!this.#scope) return undefined;
    const nodeSets = memoryRecord?.node_sets ?? deriveNodeSets({
      initiativeIdentifier: this.#scope.initiativeIdentifier,
      entityType: eventType === "initiative_selected" ? "Initiative" : "Run",
      authority,
      projectIdentifier: this.#scope.projectIdentifier,
      parentIssueIdentifier: this.#scope.parentIssueIdentifier,
      stage: this.#scope.stage,
    });
    return this.outbox.append({
      eventId: identity?.eventId,
      timestamp: identity?.timestamp,
      workspaceId: this.#scope.workspaceId,
      initiativeId: this.#scope.initiativeId,
      initiativeIdentifier: this.#scope.initiativeIdentifier,
      issueId: this.#scope.issueId,
      issueIdentifier: this.#scope.issueIdentifier,
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
    validateResolutionLinks(resolution);
    const currentProjectIdentifier = resolution.project
      ? projectIdentifier(resolution.project.title, resolution.project.id)
      : undefined;
    if (resolution.workspace.id.toLowerCase() !== this.#scope.workspaceId
      || resolution.workspace.slug !== this.#scope.workspaceIdentifier
      || resolution.issue.id.toLowerCase() !== this.#scope.issueId
      || resolution.issue.identifier !== this.#scope.issueIdentifier
      || (resolution.issue.project_id?.toLowerCase() || undefined) !== this.#scope.projectId
      || currentProjectIdentifier !== this.#scope.projectIdentifier
      || (resolution.issue.parent_issue_id?.toLowerCase() || undefined) !== this.#scope.parentIssueId
      || resolution.parent?.identifier !== this.#scope.parentIssueIdentifier) {
      throw new Error("Authoritative Multica scope changed during an immutable Workgraph process");
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

  async reconcileActivity(): Promise<number> {
    if (this.#closing) throw new Error("Workgraph is shutting down");
    const operation = this.#reconciliations.then(() => this.reconcileActivityNow());
    this.#reconciliations = operation.catch(() => undefined);
    return (await operation).captured;
  }

  async settle(): Promise<TimelineEntry> {
    if (this.#closing) throw new Error("Workgraph is shutting down");
    const operation = this.#reconciliations.then(() => this.reconcileActivityNow());
    this.#reconciliations = operation.catch(() => undefined);
    const { resolution } = await operation;
    const observedAt = new Date().toISOString();
    return this.append(
      "run_settled",
      `Work on Multica issue ${resolution.issue.identifier} settled with authoritative status ${resolution.issue.status}.`,
      this.issueSource(),
      "observed",
      undefined,
      { timestamp: observedAt },
    )!;
  }

  async compact(): Promise<TimelineEntry> {
    if (this.#closing) throw new Error("Workgraph is shutting down");
    const operation = this.#reconciliations.then(() => this.reconcileActivityNow());
    this.#reconciliations = operation.catch(() => undefined);
    const { resolution } = await operation;
    const scope = this.#scope!;
    const observedAt = new Date().toISOString();
    return this.rememberVerified({
      entityType: "Run",
      authority: "observed",
      summary: `Compaction anchor for issue ${resolution.issue.title ?? resolution.issue.identifier}; authoritative status ${resolution.issue.status}. Consult the Workgraph timeline for durable decisions, blockers, artifacts, evidence, and outcomes.`,
      source: this.issueSource(),
      entityIdentifier: semanticRecordIdentifier("compaction", scope.issueIdentifier, observedAt, scope.runId),
      entityLabel: `${scope.issueIdentifier} compaction anchor`,
      eventType: "compaction_anchor",
      observedAt,
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

  private async flushNow(
    limit: number,
    timeoutMs: number,
    deadline = Date.now() + timeoutMs,
  ): Promise<{ delivered: number; failed: number }> {
    if (!this.#scope || !this.cognee) return { delivered: 0, failed: 0 };
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
    this.#shutdown = (async () => {
      if (this.#scope) {
        const operation = this.#reconciliations.then(() => this.reconcileActivityNow());
        this.#reconciliations = operation.catch(() => undefined);
        await operation.catch(() => undefined);
      }
      const finalFlush = this.#writes.then(() => this.drainNow(25, this.#deliveryTimeoutMs));
      this.#writes = finalFlush.catch(() => undefined);
      await this.#writes;
      this.outbox.close();
    })();
    return this.#shutdown;
  }

  issueSource(): string {
    return this.#scope ? `multica://issues/${this.#scope.issueIdentifier}` : "multica://unscoped";
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

  private async reconcileActivityNow(): Promise<{ captured: number; resolution: InitiativeResolution }> {
    if (!this.#scope) throw new Error("No initiative is selected; activity reconciliation is disabled");
    const baselineStatus = this.outbox.activityBaselineStatus(this.#scope.workspaceId, this.#scope.issueId);
    if (baselineStatus === "failed") {
      throw new Error("Multica activity baseline requires operator recovery");
    }
    const needsBaseline = baselineStatus === undefined;
    let result;
    let resolution;
    try {
      result = await this.multica.issueActivities(this.#scope.issueId, this.#scope.workspaceId);
      resolution = await this.requireFreshResolution();
      if (needsBaseline) {
        this.outbox.initializeActivityBaseline(
          this.#scope.workspaceId,
          this.#scope.issueId,
          result.activities.map((activity) => activity.id),
        );
        return { captured: 0, resolution };
      }
    } catch (error) {
      if (needsBaseline) this.outbox.markActivityBaselineFailed(this.#scope.workspaceId, this.#scope.issueId);
      throw error;
    }
    const activityIds = result.activities.map((activity) => activity.id);
    if (result.truncated && !activityIds.some((activityId) =>
      this.outbox.hasSeenActivity(this.#scope!.workspaceId, this.#scope!.issueId, activityId))) {
      throw new Error("Multica activity history was truncated without overlap with Workgraph history");
    }
    let captured = 0;
    for (const activity of result.activities) {
      if (this.outbox.hasSeenActivity(this.#scope.workspaceId, this.#scope.issueId, activity.id)) continue;
      this.rememberVerified({
        entityType: "Evidence",
        authority: "observed",
        entityIdentifier: activityEntityIdentifier(activity, this.#scope.issueIdentifier),
        entityLabel: activityEntityLabel(activity, this.#scope.issueIdentifier),
        summary: summarizeActivity(activity, resolution.issue.identifier),
        source: `${this.issueSource()}/activity`,
        sourceRevision: activity.id,
        relations: [{ type: "observed_in", target: `issue:${this.#scope.issueIdentifier}` }],
        eventType: "evidence_recorded",
        eventId: `multica-activity:${activity.id}`,
        observedAt: activity.created_at,
      }, resolution, false);
      this.outbox.markActivitySeen(this.#scope.workspaceId, this.#scope.issueId, activity.id);
      captured += 1;
    }
    if (captured > 0) this.scheduleFlush();
    return { captured, resolution };
  }

  private async drainNow(batchSize: number, timeoutMs: number): Promise<{ delivered: number; failed: number }> {
    const deadline = Date.now() + timeoutMs;
    let delivered = 0;
    let failed = 0;
    while (Date.now() < deadline) {
      const result = await this.flushNow(batchSize, timeoutMs, deadline);
      delivered += result.delivered;
      failed += result.failed;
      if (result.failed > 0 || result.delivered + result.failed < batchSize) break;
    }
    return { delivered, failed };
  }

  private rememberVerified(input: RememberInput, resolution: InitiativeResolution, scheduleDelivery = true): TimelineEntry {
    if (!this.#scope) throw new Error("No initiative is selected; memory writes are disabled");
    const issue = resolution.issue;
    const nodeSets = deriveNodeSets({
      initiativeIdentifier: this.#scope.initiativeIdentifier,
      entityType: input.entityType,
      authority: input.authority,
      projectIdentifier: this.#scope.projectIdentifier,
      parentIssueIdentifier: this.#scope.parentIssueIdentifier,
      stage: issue.stage,
    });
    const record = MemoryRecordSchema.parse({
      schema_version: SCHEMA_VERSION,
      extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
      workspace_id: this.#scope.workspaceId,
      workspace_identifier: this.#scope.workspaceIdentifier,
      workspace_name: this.#scope.workspaceName,
      initiative_id: this.#scope.initiativeId,
      initiative_identifier: this.#scope.initiativeIdentifier,
      issue_id: issue.id,
      issue_identifier: this.#scope.issueIdentifier,
      project_id: issue.project_id,
      project_identifier: this.#scope.projectIdentifier,
      parent_issue_id: issue.parent_issue_id,
      parent_issue_identifier: this.#scope.parentIssueIdentifier,
      stage: issue.stage,
      entity_type: input.entityType,
      authority: input.authority,
      entity_identifier: input.entityIdentifier ?? semanticRecordIdentifier(
        input.entityType.toLowerCase(),
        this.#scope.issueIdentifier,
        input.observedAt ?? new Date().toISOString(),
      ),
      entity_label: input.entityLabel ?? `${input.entityType} for ${this.#scope.issueIdentifier}: ${boundText(input.summary, 120)}`,
      summary: boundText(input.summary, 4000),
      relations: input.relations ?? [{ type: "about", target: `initiative:${this.#scope.initiativeIdentifier}` }],
      node_sets: nodeSets,
      source: input.source,
      source_revision: input.sourceRevision,
      observed_at: input.observedAt ?? new Date().toISOString(),
    });
    const eventType = input.eventType
      ?? (input.entityType === "Decision" ? "decision_recorded"
        : input.entityType === "Blocker" ? "blocker_recorded"
          : input.entityType === "Artifact" ? "artifact_observed"
            : input.entityType === "Handoff" ? "handoff_observed"
              : "evidence_recorded");
    const event = this.append(eventType, record.summary, record.source, record.authority, record, {
      eventId: input.eventId,
      timestamp: input.observedAt,
    });
    if (!event) throw new Error("No initiative is selected; memory writes are disabled");
    if (scheduleDelivery) this.scheduleFlush();
    return event;
  }
}

function summarizeActivity(activity: MulticaActivity, issueIdentifier: string): string {
  const details = activity.details;
  const from = detailValue(details.from);
  const to = detailValue(details.to);
  let change: string;
  switch (activity.action) {
    case "status_changed": change = transition("Status", from, to); break;
    case "priority_changed": change = transition("Priority", from, to); break;
    case "title_changed": change = transition("Title", from, to); break;
    case "start_date_changed": change = transition("Start date", from, to); break;
    case "due_date_changed": change = transition("Due date", from, to); break;
    case "assignee_changed":
      change = transition("Assignee", actorValue(details, "from"), actorValue(details, "to"));
      break;
    case "created": change = "Issue was created."; break;
    case "description_updated": change = "Description was updated."; break;
    case "task_completed": change = "Task completed."; break;
    case "task_failed": change = "Task failed."; break;
    case "squad_leader_evaluated": {
      const outcome = detailValue(details.outcome);
      change = outcome ? `Squad leader evaluation recorded outcome ${outcome}.` : "Squad leader evaluation was recorded.";
      break;
    }
    default: change = `Multica recorded activity ${boundText(activity.action, 128)}.`;
  }
  const actor = activity.actor_type
    ? ` Actor type: ${boundText(activity.actor_type, 128)}.`
    : "";
  return `Multica issue ${issueIdentifier}: ${change}${actor}`;
}

function transition(label: string, from: string | undefined, to: string | undefined): string {
  return `${label} changed from ${from ?? "(none)"} to ${to ?? "(none)"}.`;
}

function actorValue(details: Record<string, unknown>, prefix: "from" | "to"): string | undefined {
  return detailValue(details[`${prefix}_type`]);
}

function detailValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? boundText(String(value), 300)
    : undefined;
}

function projectIdentifier(title: string, id: string): string {
  const readable = title.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `${readable || "project"}-${id.slice(0, 8).toLowerCase()}`;
}

function validateResolutionLinks(resolution: InitiativeResolution): void {
  const projectId = resolution.issue.project_id?.toLowerCase();
  if ((projectId === undefined) !== (resolution.project === undefined)
    || (resolution.project && (resolution.project.id.toLowerCase() !== projectId
      || resolution.project.workspace_id.toLowerCase() !== resolution.workspace.id.toLowerCase()))) {
    throw new Error("Multica project metadata does not match the resolved issue");
  }
  const parentId = resolution.issue.parent_issue_id?.toLowerCase();
  if ((parentId === undefined) !== (resolution.parent === undefined)
    || (resolution.parent && (resolution.parent.id.toLowerCase() !== parentId
      || resolution.parent.workspace_id.toLowerCase() !== resolution.workspace.id.toLowerCase()))) {
    throw new Error("Multica parent metadata does not match the resolved issue");
  }
}

function semanticRecordIdentifier(kind: string, issueIdentifier: string, observedAt: string, seed: string = randomUUID()): string {
  const timestamp = observedAt.replace(/[-:.]/g, "").replace(/Z$/, "Z");
  return `${kind.replace(/_/g, "-")}:${issueIdentifier}:${timestamp}:${shortHash(seed)}`;
}

function activityEntityIdentifier(activity: MulticaActivity, issueIdentifier: string): string {
  return semanticRecordIdentifier(`evidence-${activity.action}`, issueIdentifier, activity.created_at, activity.id);
}

function activityEntityLabel(activity: MulticaActivity, issueIdentifier: string): string {
  return `${issueIdentifier} ${activity.action.replace(/_/g, " ")}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
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
      entityIdentifier: record.entity_identifier,
      entityLabel: record.entity_label,
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
  const marker = "WORKGRAPH_RECORD_V1";
  const payload = text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : text;
  const trimmed = payload.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
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
