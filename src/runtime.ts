import { createHash, randomUUID } from "node:crypto";
import { outboxPath, rememberTimeout } from "./config.js";
import {
  CogneeApiClient,
  createCogneeClientFromEnv,
} from "./cognee.js";
import {
  MulticaReader,
  type InitiativeResolution,
  type MulticaWorkspace,
} from "./multica.js";
import { summarizeActivity, inspectHandoff } from "./activity.js";
import { recallValidMemories } from "./recall.js";
import { WorkgraphOutbox, type TimelineEntry, type TimelineFilter } from "./outbox.js";
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
  errors?: Partial<Record<"initiative" | "workspace", "recall_failed">>;
}

export interface WorkgraphContext {
  resolution: InitiativeResolution;
  memory: WorkgraphRecall;
  memoryError?: string;
}

export interface WorkgraphWorkspaceContext {
  workspace: MulticaWorkspace;
  memory: RecalledMemory[];
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
  readonly #recallIds = new WeakMap<WorkgraphRecall, string>();
  readonly #deliveryTimeoutMs: number;
  #scope?: WorkgraphScope;
  #writes = Promise.resolve<unknown>(undefined);
  #reconciliations = Promise.resolve<unknown>(undefined);
  #closing = false;
  #shutdown?: Promise<void>;

  constructor(options: WorkgraphRuntimeOptions = {}) {
    this.env = Object.freeze({ ...(options.env ?? process.env) });
    // Validate configuration before opening SQLite so failures cannot leak a connection.
    this.cognee = options.cognee ?? createCogneeClientFromEnv(this.env);
    this.#deliveryTimeoutMs = rememberTimeout(this.env);
    this.multica = options.multica ?? new MulticaReader({
      binary: this.env.MULTICA_BIN?.trim() || "multica", env: this.env,
    });
    this.outbox = options.outbox ?? new WorkgraphOutbox(outboxPath(this.env));
  }

  get scope(): Readonly<WorkgraphScope> | undefined { return this.#scope; }

  lockInitiative(resolution: InitiativeResolution): WorkgraphScope {
    if (this.#scope) throw new Error("Workgraph scope is immutable for the lifetime of this harness process");
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
    identity?: { eventId?: string; timestamp?: string; sourceRevision?: string },
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
      sourceRevision: memoryRecord?.source_revision ?? identity?.sourceRevision,
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
      const memory = await this.recallVerified(query, "both", 8, signal);
      return { resolution, memory, ...(memory.errors ? { memoryError: "Some memory lanes are unavailable" } : {}) };
    } catch (error) {
      return {
        resolution,
        memory: {},
        memoryError: boundText(error instanceof Error ? error.message : String(error), 500),
      };
    }
  }

  /** Fresh workflow facts and durable continuations remain usable when semantic recall fails. */
  async deliveryContext() {
    const resolution = await this.requireFreshResolution();
    const children = await this.multica.children(resolution.issue.id, resolution.workspace.id);
    const summary = `Issue ${resolution.issue.identifier}: ${resolution.issue.status_category ?? resolution.issue.status}.`
      + ` Parent: ${resolution.parent?.identifier ?? "none"}.`
      + ` Direct children: ${children.map((child) => `${child.identifier}=${child.status_category ?? child.status}`).join(", ") || "none"}.`;
    const fingerprint = createHash("sha256").update(JSON.stringify({
      summary, revision: resolution.issue.revision, parent: resolution.parent?.id, children: children.map((child) => child.id).sort(),
    })).digest("hex");
    if (!this.timeline(1, { eventId: `issue-state:${this.#scope!.issueId}:${fingerprint}` }).length) {
      this.rememberVerified({ entityType: "Issue", authority: "observed",
        entityIdentifier: `issue:${resolution.issue.identifier}`, entityLabel: `${resolution.issue.identifier} workflow state`,
        summary, source: this.issueSource(), sourceRevision: String(resolution.issue.revision ?? fingerprint),
        eventId: `issue-state:${this.#scope!.issueId}:${fingerprint}`,
        relations: [
          { type: "part_of", target: `initiative:${resolution.root.identifier}` },
          ...(resolution.parent ? [{ type: "child_of" as const, target: `issue:${resolution.parent.identifier}` }] : []),
        ],
      }, resolution);
    }
    let continuations: Awaited<ReturnType<MulticaReader["continuations"]>> | undefined;
    try { continuations = await this.multica.continuations(resolution.issue.id, resolution.workspace.id); }
    catch { /* Older or unavailable Multica is unknown, never an empty queue. */ }
    const node = (kind: string, id: string) => `${kind}:${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
    for (const c of continuations ?? []) {
      const eventId = `native-continuation:${c.source_task_id}:${c.updated_at}`;
      if (this.timeline(1, { eventId }).length) continue;
      this.rememberVerified({ entityType: "Handoff", authority: "observed",
        entityIdentifier: node("handoff", c.source_task_id), entityLabel: `${resolution.issue.identifier} continuation`,
        summary: `Native Multica continuation ${c.state}. Next action: ${c.next_action}.`
          + ` Event: ${c.event_key || "immediate"}. Successor run: ${c.successor_task_id ?? "not yet queued"}.`,
        source: `${this.issueSource()}/continuations?source_task_id=${c.source_task_id}`, sourceRevision: c.updated_at, eventId,
        relations: [{ type: "about", target: `issue:${resolution.issue.identifier}` },
          { type: "delegated_to", target: node("agent", c.agent_id) },
          { type: "derived_from", target: node("run", c.source_task_id) },
          ...(c.successor_task_id ? [{ type: "resulted_in" as const, target: node("run", c.successor_task_id) }] : []),
        ],
      }, resolution);
    }
    return {
      authority: "multica", ontologyVersion: "multica-delivery/v1",
      continuations, continuationAvailability: continuations ? "available" : "unavailable",
      current: { identifier: resolution.issue.identifier, status: resolution.issue.status,
        parent: resolution.parent?.identifier },
      children: children.map((child) => ({ identifier: child.identifier, status: child.status,
        status_category: child.status_category })),
      handoffCapture: this.outbox.handoffCapture(resolution.workspace.id, resolution.issue.id),
      recentHandoffs: this.timeline(50).filter((event) => event.eventType === "handoff_observed")
        .slice(-5).map((event) => ({ summary: event.boundedSummary, source: event.source, timestamp: event.timestamp })),
    };
  }

  /** Explicit bounded repair reconsiders comments skipped by an older parser, without resetting cursors. */
  async repairHandoffs(since: string): Promise<number> {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(since) || !Number.isFinite(Date.parse(since))) throw new Error("A valid since timestamp is required");
    const resolution = await this.requireFreshResolution();
    const result = await this.multica.issueActivities(resolution.issue.id, resolution.workspace.id);
    if (result.truncated) throw new Error("Cannot repair truncated history; use a complete source export");
    let captured = 0;
    for (const comment of result.handoffs ?? []) {
      if (Date.parse(comment.created_at) < Date.parse(since)) continue;
      const { summary, reason } = inspectHandoff(comment);
      this.outbox.auditHandoff(this.#scope!.workspaceId, this.#scope!.issueId, comment.id, reason);
      if (!summary || this.timeline(1, { eventId: `multica-handoff:${comment.id}` }).length) continue;
      this.rememberVerified({ entityType: "Handoff", authority: "observed", summary,
        entityIdentifier: `handoff:${this.#scope!.issueIdentifier.toLowerCase()}:${createHash("sha256").update(comment.id).digest("hex").slice(0,16)}`,
        entityLabel: `${this.#scope!.issueIdentifier} agent handoff`,
        source: `${this.issueSource()}/comments/${comment.id}`, sourceRevision: comment.id,
        relations: [{ type: "about", target: `issue:${this.#scope!.issueIdentifier}` }],
        eventType: "handoff_observed", eventId: `multica-handoff:${comment.id}`, observedAt: comment.created_at,
      }, resolution, false);
      captured++;
    }
    this.scheduleFlush();
    return captured;
  }

  async workspaceContext(query: string, topK = 8, signal?: AbortSignal): Promise<WorkgraphWorkspaceContext> {
    const workspaceId = this.env.MULTICA_WORKSPACE_ID?.trim();
    if (!workspaceId) throw new Error("MULTICA_WORKSPACE_ID is required for workspace recall");
    const workspace = await this.multica.workspace(workspaceId);
    const boundedTopK = Math.min(20, Math.max(1, Math.trunc(topK)));
    try {
      if (!this.cognee) throw new Error("Cognee is not configured");
      const memories = await recallValidMemories(
        this.cognee,
        boundText(query, 2000),
        datasetForWorkspace(workspace.slug),
        { topK: boundedTopK, signal },
      );
      return {
        workspace,
        memory: memories.filter((record) => record.workspaceId === workspace.id.toLowerCase()).slice(0, boundedTopK),
      };
    } catch (error) {
      return {
        workspace,
        memory: [],
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
    if (this.#closing) throw new Error("Workgraph is shutting down");
    const resolution = await this.requireFreshResolution();
    if (this.#closing) throw new Error("Workgraph is shutting down");
    return this.rememberVerified(input, resolution);
  }

  /** Exact selection of remote records; local text is only a bounded query hint. */
  async recallEntity(query: string, entityIdentifier: string, signal?: AbortSignal): Promise<WorkgraphRecall> {
    await this.requireFreshResolution();
    if (!this.cognee) throw new Error("Cognee is not configured; remote entity recall is unavailable");
    const identifier = requiredValue(entityIdentifier, "Entity identifier");
    if (identifier.length > 512) throw new Error("Entity identifier exceeds 512 characters");
    const select = (result: WorkgraphRecall) => (result.initiative ?? [])
      .filter((record) => record.entityIdentifier === identifier);
    let matches = select(await this.recallVerified(query, "initiative", 20, signal));
    if (matches.length === 0) {
      const hint = this.timeline(1, { entityIdentifier: identifier })[0]?.memoryRecord;
      if (hint) {
        const retryQuery = boundText(`${hint.entity_label}\n${hint.summary}`, 2000);
        if (retryQuery !== boundText(query, 2000)) {
          matches = select(await this.recallVerified(retryQuery, "initiative", 20, signal));
        }
      }
    }
    return { initiative: matches };
  }

  async reconcileActivity(): Promise<number> {
    if (this.#closing) throw new Error("Workgraph is shutting down");
    const operation = this.#reconciliations.then(() => this.reconcileActivityNow());
    this.#reconciliations = operation.catch(() => undefined);
    const { captured } = await operation;
    this.scheduleFlush(); // Retry old records even when no new activity exists.
    return captured;
  }

  async settle(): Promise<TimelineEntry> {
    if (this.#closing) throw new Error("Workgraph is shutting down");
    const operation = this.#reconciliations.then(() => this.reconcileActivityNow());
    this.#reconciliations = operation.catch(() => undefined);
    const { resolution } = await operation;
    let deliveryWarning = "";
    try { await this.deliveryContext(); }
    catch { deliveryWarning = " Delivery state refresh unavailable; verify continuation before claiming completion."; }
    this.scheduleFlush();
    const observedAt = new Date().toISOString();
    return this.append(
      "run_settled",
      `Work on Multica issue ${resolution.issue.identifier} settled with authoritative status ${resolution.issue.status}.${deliveryWarning}`,
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
      // Keep ownership past the HTTP batch budget to allow delivery bookkeeping.
      // This is a grace period, not a heartbeat; expired claims remain reclaimable.
      timeoutMs + 1000,
    );
    try {
      for (const event of events) {
        if (Date.now() >= deadline) break;
        if (!event.memoryRecord) continue;
        try {
          await this.cognee.remember(
            event.memoryRecord,
            datasetForWorkspace(event.memoryRecord.workspace_identifier),
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
    } finally {
      this.outbox.releaseClaims(this.#flushOwner);
    }
    return { delivered, failed };
  }

  timeline(limit = 100, filter: TimelineFilter = {}): TimelineEntry[] {
    return this.#scope ? this.outbox.timeline(this.#scope.initiativeId, limit, filter, this.#scope.workspaceId) : [];
  }

  pendingCount(): number {
    return this.#scope ? this.outbox.pendingCount(this.#scope.workspaceId) : 0;
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
    if (!this.#scope) return {};
    if (!this.cognee) throw new Error("Cognee is not configured");
    const boundedQuery = boundText(query, 2000);
    const boundedTopK = Math.min(20, Math.max(1, Math.trunc(topK)));
    const activeInitiativeNodeSet = initiativeNodeSet(this.#scope.initiativeIdentifier);
    const result: WorkgraphRecall = {};
    const recallId = randomUUID();
    this.#recallIds.set(result, recallId);
    const startedAt = Date.now();
    const metrics: Record<string, object> = {};
    let failure: unknown;
    const lanes = scope === "both" ? ["initiative", "workspace"] as const : [scope];
    for (const lane of lanes) {
      const laneStartedAt = Date.now();
      try {
        const memories = await recallValidMemories(this.cognee, boundedQuery, this.#scope.dataset, {
          topK: lane === "workspace" && scope === "both" ? 20 : boundedTopK,
          ...(lane === "initiative" ? { nodeNames: [activeInitiativeNodeSet] } : {}), signal,
        }, (stats) => { metrics[lane] = stats; });
        result[lane] = memories.filter((record) => record.workspaceId === this.#scope!.workspaceId
          && (lane === "initiative"
            ? record.initiativeId === this.#scope!.initiativeId && record.initiativeIdentifier === this.#scope!.initiativeIdentifier
            : record.initiativeId !== this.#scope!.initiativeId))
          .slice(0, lane === "workspace" && scope === "both" ? 4 : boundedTopK);
      } catch (error) {
        failure = error;
        (result.errors ??= {})[lane] = "recall_failed";
      } finally {
        metrics[lane] = { ...metrics[lane], durationMs: Date.now() - laneStartedAt,
          retained: result[lane]?.length ?? 0 };
      }
    }
    this.outbox.auditRecall(this.#scope, "retrieved", {
      recallId, durationMs: Date.now() - startedAt, scope, metrics, errors: result.errors ?? {},
      initiativeIds: result.initiative?.map((m) => m.entityIdentifier) ?? [],
      workspaceIds: result.workspace?.map((m) => m.entityIdentifier) ?? [],
    });
    if (scope !== "both" && result.errors) throw failure;
    if (result.initiative || result.workspace) this.append("context_recalled",
      `Recalled ${scope} context: initiative=${result.initiative?.length ?? 0}, workspace=${result.workspace?.length ?? 0}, failed=${Object.keys(result.errors ?? {}).join(",") || "none"}.`,
      "cognee://recall", "inferred");
    return result;
  }

  auditInjected(initiativeIds: string[], workspaceIds: string[], memory: WorkgraphRecall): void {
    if (this.#scope) this.outbox.auditRecall(this.#scope, "injected", {
      recallId: this.#recallIds.get(memory), initiativeIds, workspaceIds,
    });
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
      const activityIds = [...result.activities.map((activity) => activity.id), ...(result.handoffs ?? []).map((comment) => comment.id)];
      if (!needsBaseline && result.truncated && !activityIds.some((activityId) =>
        this.outbox.hasSeenActivity(this.#scope!.workspaceId, this.#scope!.issueId, activityId))) {
        throw new Error("Multica activity history was truncated without overlap with Workgraph history");
      }
      this.outbox.initializeHandoffBaseline(this.#scope.workspaceId, this.#scope.issueId,
        (result.handoffs ?? []).map((comment) => comment.id));
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
    let captured = 0;
    for (const activity of result.activities) {
      if (this.outbox.hasSeenActivity(this.#scope.workspaceId, this.#scope.issueId, activity.id)) continue;
      // Preserve exact operational chronology locally without paying to graph/embed it.
      this.append("evidence_recorded", summarizeActivity(activity, resolution.issue.identifier),
        `${this.issueSource()}/activity`, "observed", undefined,
        { eventId: `multica-activity:${activity.id}`, timestamp: activity.created_at, sourceRevision: activity.id });
      this.outbox.markActivitySeen(this.#scope.workspaceId, this.#scope.issueId, activity.id);
      captured += 1;
    }
    for (const comment of result.handoffs ?? []) {
      if (this.outbox.hasSeenActivity(this.#scope.workspaceId, this.#scope.issueId, comment.id)) continue;
      const { summary, reason } = inspectHandoff(comment);
      this.outbox.auditHandoff(this.#scope!.workspaceId, this.#scope!.issueId, comment.id, reason);
      if (summary) {
        this.rememberVerified({
          entityType: "Handoff", authority: "observed", summary,
          entityIdentifier: `handoff:${this.#scope.issueIdentifier.toLowerCase()}:${createHash("sha256").update(comment.id).digest("hex").slice(0,16)}`,
          entityLabel: `${this.#scope.issueIdentifier} agent handoff`,
          source: `${this.issueSource()}/comments/${comment.id}`, sourceRevision: comment.id,
          relations: [{ type: "about", target: `issue:${this.#scope.issueIdentifier}` }],
          eventType: "handoff_observed", eventId: `multica-handoff:${comment.id}`, observedAt: comment.created_at,
        }, resolution, false);
        captured += 1;
      }
      this.outbox.markActivitySeen(this.#scope.workspaceId, this.#scope.issueId, comment.id);
    }
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
      // Finish the current batch, then stop on failure rather than immediately
      // reclaiming its failed rows in a tight shutdown retry loop.
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
      relations: input.relations?.map((relation) => ({
        ...relation,
        target: canonicalRelationTarget(relation.target),
      })) ?? [{ type: "about", target: `initiative:${this.#scope.initiativeIdentifier}` }],
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

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function canonicalRelationTarget(target: string): string {
  const trimmed = target.trim();
  return /^[A-Za-z][A-Za-z0-9._-]*-\d+$/.test(trimmed) ? `issue:${trimmed.toUpperCase()}` : trimmed;
}

function requiredValue(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}
