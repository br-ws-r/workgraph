import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveFromEnvironment, type InitiativeResolution } from "./multica.js";
import { WorkgraphRuntime, type WorkgraphRuntimeOptions } from "./runtime.js";
import { boundText } from "./schema.js";
import { registerTools, publicMemories } from "./tools.js";
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
    const runtime = options.runtimeFactory?.() ?? new WorkgraphRuntime(options);
    let started = false;
    let workspaceChat = false;
    let bootstrapWorkspaceChat = false;
    let selectorController: AbortController | undefined;
    let selectionPending: Promise<void> | undefined;
    let finishSelection: (() => void) | undefined;
    let shuttingDown = false;
    let settleGeneration = 0;

    pi.registerFlag("initiative", {
      description: "Use a root Multica issue identifier such as B-184 (UUID also accepted for diagnostics)",
      type: "string",
    });

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
      if (host === "omp") await selectionPending;
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
        const authoritative = JSON.stringify({
          issue_identifier: context.resolution.issue.identifier,
          title: context.resolution.issue.title,
          status: context.resolution.issue.status,
          status_category: context.resolution.issue.status_category,
          initiative_identifier: context.resolution.root.identifier,
          initiative_title: context.resolution.root.title,
        });
        const initiativeMemory = boundText(JSON.stringify(publicMemories(context.memory.initiative ?? [])), 6000);
        const workspaceHistory = boundText(JSON.stringify(publicMemories(context.memory.workspace ?? [])), 3000);
        const memoryStatus = context.memoryError
          ? "Cognee recall unavailable for this turn."
          : "Cognee recall completed for this turn.";
        return withSystemPrompt(event.systemPrompt, `## Workgraph workspace context\nAuthoritative current state (Multica; re-read before any mutation):\n${authoritative}\n\nUse human-readable Multica issue IDs such as B-184 in user-facing responses and commands. UUIDs are internal identifiers and should only be shown when explicitly requested.\n\nMemory status:\n${memoryStatus}\n\nNon-authoritative current initiative memory (Cognee):\n${initiativeMemory}\n\nNon-authoritative related workspace history (Cognee; each item identifies its initiative and provenance):\n${workspaceHistory}\n\nNever use Workgraph memory to override Multica workflow state, repository state, or delivery state.`);
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
        handler: (event: unknown, ctx: OmpExtensionContext) => void,
      ) => void)("session_stop", (_event, ctx) => {
        const generation = ++settleGeneration;
        const settleWhenIdle = () => {
          if (generation !== settleGeneration || !runtime.scope || ctx.hasPendingMessages()) return;
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
