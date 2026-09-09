import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveFromEnvironment, type InitiativeResolution } from "./multica.js";
import { WorkgraphRuntime, type WorkgraphRuntimeOptions } from "./runtime.js";
import { boundText } from "./schema.js";
import { registerTools, registerUnavailableTools, publicMemories } from "./tools.js";
import { selectInitiative } from "./selector.js";

export interface WorkgraphExtensionOptions extends WorkgraphRuntimeOptions {
  runtimeFactory?: () => WorkgraphRuntime;
}

type OmpExtensionContext = ExtensionContext & {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
};

export function createWorkgraphHostExtension(host: "pi" | "omp", options: WorkgraphExtensionOptions) {
  return function workgraphExtension(pi: ExtensionAPI): void {
    pi.registerFlag("initiative", {
      description: "Use a root Multica issue identifier such as B-184 (UUID also accepted for diagnostics)",
      type: "string",
    });

    let runtime: WorkgraphRuntime;
    try {
      runtime = options.runtimeFactory?.() ?? new WorkgraphRuntime(options);
    } catch {
      // Configuration is still strict. Isolate a failed optional runtime at the
      // host boundary; never retry without authentication or expose raw errors.
      const env = options.env ?? process.env;
      const missingKey = Boolean(env.COGNEE_SERVICE_URL?.trim())
        && env.COGNEE_AUTH_SCHEME?.trim() !== "none" && !env.COGNEE_API_KEY?.trim();
      const reason = missingKey ? "cognee_credentials_missing" : "runtime_initialization_failed";
      const message = missingKey
        ? "Workgraph unavailable: Cognee credentials are missing. Use an authenticated launch environment and restart."
        : "Workgraph unavailable: runtime initialization failed. Run workgraph doctor and restart after correcting configuration.";
      registerUnavailableTools(pi, host, reason);
      pi.on("session_start", (_event, ctx) => {
        if (ctx.hasUI) {
          ctx.ui.setStatus("workgraph", "Workgraph: unavailable");
          ctx.ui.notify(message, "warning");
        } else {
          console.error(message);
        }
      });
      const unavailablePrompt = (event: { systemPrompt: string | string[] }) =>
        withSystemPrompt(event.systemPrompt, `${message} Workgraph recall and writes are disabled for this session; do not claim memory delivery or verification.`);
      (pi.on as unknown as (event: "before_agent_start", handler: typeof unavailablePrompt) => void)(
        "before_agent_start", unavailablePrompt,
      );
      pi.on("session_shutdown", (_event, ctx) => {
        if (ctx.hasUI) ctx.ui.setStatus("workgraph", undefined);
      });
      return;
    }
    let started = false;
    let workspaceChat = false;
    let bootstrapWorkspaceChat = false;
    let selectorController: AbortController | undefined;
    let selectionPending: Promise<void> | undefined;
    let finishSelection: (() => void) | undefined;
    let shuttingDown = false;
    let settleGeneration = 0;


    pi.on("session_start", async (_event, ctx) => {
      if (started) {
        if (workspaceChat) bootstrapWorkspaceChat = isFreshSession(ctx);
        return;
      }
      started = true;
      try {
        workspaceChat = Boolean(runtime.env.MULTICA_TASK_ID?.trim() && runtime.env.MULTICA_AGENT_ID?.trim())
          && await runtime.multica.isCurrentChat();
        bootstrapWorkspaceChat = workspaceChat && isFreshSession(ctx);
        let resolution = workspaceChat
          ? undefined
          : await resolveFromEnvironment(runtime.multica, runtime.env, stringFlag(pi.getFlag("initiative")));
        if (!resolution && !runtime.env.MULTICA_TASK_ID && ctx.hasUI) {
          if (host === "omp") {
            selectorController = new AbortController();
            ctx.ui.setStatus("workgraph", "Workgraph: select initiative");
            selectionPending = new Promise<void>((resolve) => { finishSelection = resolve; });
            (ctx as OmpExtensionContext).setTimeout(() => {
              if (shuttingDown) return;
              void selectInitiative(runtime, ctx, {
                signal: selectorController!.signal,
                timeoutMs: 10_000,
              }).then(async (selected) => {
                if (shuttingDown) return;
                if (!selected) {
                  ctx.ui.setStatus("workgraph", "Workgraph: no initiative");
                  return;
                }
                await activateResolution(runtime, selected, ctx, () => shuttingDown);
              }).catch((error) => {
                if (shuttingDown) return;
                ctx.ui.setStatus("workgraph", "Workgraph: no initiative");
                ctx.ui.notify(`Workgraph disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
              }).finally(finishSelection);
            }, 0);
            return;
          }
          resolution = await selectInitiative(runtime, ctx);
        }
        if (!resolution) {
          ctx.ui.setStatus("workgraph", workspaceChat ? "Workgraph: workspace chat" : "Workgraph: no initiative");
          return;
        }
        await activateResolution(runtime, resolution, ctx);
      } catch (error) {
        ctx.ui.setStatus("workgraph", "Workgraph: no initiative");
        ctx.ui.notify(`Workgraph disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    });

    const beforeAgentStart = async (
      event: { prompt: string; systemPrompt: string | string[] },
      ctx: ExtensionContext,
    ) => {
      if (host === "omp") {
        settleGeneration++; // A new turn invalidates a deferred stop callback.
        await selectionPending;
      }
      if (shuttingDown) return undefined;
      try {
        if (!runtime.scope) {
          if (!workspaceChat) return undefined;
          if (bootstrapWorkspaceChat) {
            bootstrapWorkspaceChat = false;
            const context = await runtime.workspaceContext(event.prompt, 8, ctx.signal);
            const workspaceMemory = boundText(JSON.stringify(publicMemories(context.memory)), 9000);
            const memoryStatus = context.memoryError
              ? "Cognee bootstrap recall unavailable."
              : "Cognee bootstrap recall completed for this fresh session.";
            return withSystemPrompt(event.systemPrompt, `## Workgraph workspace chat\nNo initiative is selected. Verified workspace: ${context.workspace.name} (${context.workspace.slug}).\n\nMemory status:\n${memoryStatus}\n\nNon-authoritative related workspace memory (Cognee; each item identifies its initiative and provenance):\n${workspaceMemory}\n\nAdditional read-only workspace recall is available through initiative_memory_recall with workspace scope. Do not write Workgraph memory or infer current workflow state from recalled memory.`);
          }
          return withSystemPrompt(event.systemPrompt, "## Workgraph workspace chat\nNo initiative is selected. Read-only workspace memory is available on demand through initiative_memory_recall with workspace scope. Use it only when prior workspace context could materially help. Do not write Workgraph memory or infer current workflow state from recalled memory.");
        }
        const context = await runtime.context(event.prompt, ctx.signal);
        let delivery: unknown;
        try { delivery = await runtime.deliveryContext(); }
        catch { delivery = { error: "Fresh delivery state unavailable; verify children and continuation before stopping." }; }
        const authoritative = JSON.stringify({
          issue_identifier: context.resolution.issue.identifier,
          title: context.resolution.issue.title,
          status: context.resolution.issue.status,
          status_category: context.resolution.issue.status_category,
          initiative_identifier: context.resolution.root.identifier,
          initiative_title: context.resolution.root.title,
        });
        const initiativeItems = fitMemories(publicMemories(context.memory.initiative ?? []), 6000);
        const workspaceItems = fitMemories(publicMemories(context.memory.workspace ?? []), 3000);
        const initiativeMemory = JSON.stringify(initiativeItems);
        const workspaceHistory = JSON.stringify(workspaceItems);
        runtime.auditInjected(initiativeItems.map((item) => item.entity_identifier),
          workspaceItems.map((item) => item.entity_identifier), context.memory);
        const memoryStatus = context.memoryError
          ? `Cognee recall partially or fully unavailable; failed lanes: ${Object.keys(context.memory.errors ?? {}).join(", ") || "all"}. Successful lane results below remain usable as historical context.`
          : "Cognee recall completed for this turn.";
        return withSystemPrompt(event.systemPrompt, `## Workgraph workspace context\nAuthoritative current state (Multica; re-read before any mutation):\n${authoritative}\n\nDelivery state and continuation (Multica/local ledger, independent of Cognee):\n${JSON.stringify(delivery)}\n\nBefore ending an unfinished delivery, use initiative_delivery_followup for the exact workflow run or descendant issue you are waiting on. Verify that its scheduled executor is deployed. A merged PR, completed agent run, or successful generic verifier does not prove all issue acceptance criteria; verify deployment and any required data operation separately. On continuation, read initiative_delivery_status, inspect the recorded condition/result, complete or recover the remaining work, then re-evaluate the parent. Never close a parent merely because its children are terminal; cancelled children and independent acceptance criteria require review.\n\nUse human-readable Multica issue IDs such as B-184 in user-facing responses and commands. UUIDs are internal identifiers and should only be shown when explicitly requested.\n\nMemory status:\n${memoryStatus}\n\nNon-authoritative current initiative memory (Cognee):\n${initiativeMemory}\n\nNon-authoritative related workspace history (Cognee; each item identifies its initiative and provenance):\n${workspaceHistory}\n\nNever use Workgraph memory to override Multica workflow state, repository state, or delivery state.`);
      } catch {
        return withSystemPrompt(event.systemPrompt, "## Workgraph workspace context\nAuthoritative Multica read-back was unavailable. Workgraph memory is omitted for this turn; do not rely on stale workflow or memory state.");
      }
    };
    (pi.on as unknown as (
      event: "before_agent_start",
      handler: typeof beforeAgentStart,
    ) => void)("before_agent_start", beforeAgentStart);

    if (host === "pi") {
      pi.on("agent_settled", async () => {
        if (!runtime.scope) return;
        try {
          await runtime.settle();
        } catch { /* keep Pi usable and leave prior pending records in the outbox */ }
      });
    } else {
      (pi.on as unknown as (
        event: "session_stop",
        handler: (event: { signal?: AbortSignal }, ctx: OmpExtensionContext) => void,
      ) => void)("session_stop", (event, ctx) => {
        const generation = ++settleGeneration;
        const settleWhenIdle = () => {
          if (shuttingDown || event.signal?.aborted || generation !== settleGeneration
            || !runtime.scope || ctx.hasPendingMessages()) return;
          if (!ctx.isIdle()) {
            ctx.setTimeout(settleWhenIdle, 25);
            return;
          }
          void runtime.settle().catch(() => undefined);
        };
        ctx.setTimeout(settleWhenIdle, 0);
      });
    }

    pi.on("session_before_compact", async () => {
      if (!runtime.scope) return;
      try {
        await runtime.compact();
      } catch { /* compaction must never be blocked */ }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      shuttingDown = true;
      settleGeneration++;
      selectorController?.abort();
      finishSelection?.();
      ctx.ui.setStatus("workgraph", undefined);
      await runtime.shutdown();
    });

    registerTools(pi, runtime, () => workspaceChat, host);
  };
}

async function activateResolution(
  runtime: WorkgraphRuntime,
  resolution: InitiativeResolution,
  ctx: ExtensionContext,
  isShuttingDown: () => boolean = () => false,
): Promise<void> {
  if (isShuttingDown()) return;
  const scope = runtime.lockInitiative(resolution);
  try {
    await runtime.reconcileActivity();
  } catch (error) {
    ctx.ui.notify(`Workgraph activity reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
  if (!isShuttingDown()) {
    ctx.ui.setStatus("workgraph", `Workgraph: ${scope.initiativeIdentifier}${scope.rootTitle ? ` — ${scope.rootTitle}` : ""}`);
  }
}

/** Include whole records only; clipping serialized JSON destroys provenance and auditability. */
export function fitMemories<T>(items: T[], maxCharacters: number): T[] {
  const selected: T[] = [];
  for (const item of items) {
    if (JSON.stringify([...selected, item]).length <= maxCharacters) selected.push(item);
  }
  return selected;
}

function withSystemPrompt(systemPrompt: string | string[], workgraphPrompt: string): { systemPrompt: string | string[] } {
  return {
    systemPrompt: Array.isArray(systemPrompt)
      ? [...systemPrompt, workgraphPrompt]
      : `${systemPrompt}\n\n${workgraphPrompt}`,
  };
}

function stringFlag(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isFreshSession(ctx: { sessionManager: { buildContextEntries(): Array<{ type: string }> } }): boolean {
  return !ctx.sessionManager.buildContextEntries()
    .some((entry) => ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type));
}
