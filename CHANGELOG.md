# Changelog

## Unreleased

- Fix handoff capture for actual dash/colon/Markdown and merged/decision formats;
  expose rejection counts and add bounded, idempotent repair of skipped comments.
- Record explicit issue/parent graph edges and inject live direct-child states
  and local delivery context independently of Cognee recall.
- Persist parent/child and exact-workflow continuations with an opt-in scheduled
  executor, ownership revalidation, per-owner dispatch reservation and visible
  ambiguous outcomes. Agent acceptance remains required before issue completion.

- Capture bounded, sourced agent handoff narratives as observed memory; retain
  generic status/task activity only in the exact SQLite timeline. Baseline old
  comments without replaying them, preserving all existing data.
- Keep successful initiative/workspace recall lanes on partial failure, fit
  complete records into prompts, and audit scoped retrieval and inserted IDs
  with counts/latency under both Pi and OMP. No new model or provider dependency.


- Keep Pi and OMP usable when Workgraph runtime initialization fails, including
  a configured Cognee URL without credentials. Report unavailable memory in
  UI/headless output, prompt context and a diagnostic status tool; do not relax
  authentication or register recall/write tools.

- Clarify the selector default, Bun binding keys, Git build ordering and shutdown
  retry policy; remove unused delivery event types from the exported vocabulary.
- Keep OMP and Pi on one shared extension/runtime with separate stable entrypoints.
- Support Bun's native SQLite for OMP; require Node 22.19+ for Node execution.
- Remove Pi SDK runtime dependencies; add a harness-independent `./core` export.
- Add strict Cognee configuration and a read-only `workgraph doctor` CLI.
- Correct NodeSet validation, unavailable recall reporting, full pending counts,
  unfinished delivery claims, original dataset routing and timeline scope checks.
- Freeze launch environments and pass them to Multica subprocesses; release OMP
  selection waits during shutdown. Omit prompt text from recall timeline events.
- Reject Cognee redirects and omit raw HTTP error bodies from persisted errors.
- Verify installed npm artifacts under Node/Bun and document pinned Git/tarball
  distribution, private registry options, self-hosting, backup and recovery.
- Block accidental registry publication with `private: true`; Git/tarball installs
  remain supported. No v3 data migration is required.

- Return a stable event ID from queued writes and allow exact event/entity
  lookup and explicit/activity filtering in the local initiative timeline.
- Add initiative-only exact entity selection for Cognee recall, with one bounded
  retry using local record text when available; never return local data as remote recall.
- Retry existing pending deliveries at startup and settlement even without new
  Multica activity, and discard stale or aborted OMP settlement callbacks.
- Add bidirectional Pi/OMP delivery and restart tests using real Workgraph
  runtime/SQLite with simulated Cognee HTTP, plus a live relay acceptance protocol.
- Add an OMP-specific extension entrypoint over the existing Workgraph runtime,
  with essential tools, segmented system prompts, idle settlement, and a
  non-blocking interactive selector that defaults to no initiative after ten
  seconds while explicit and Multica-managed runs start without that delay.
- Bootstrap a fresh verified workspace chat with one bounded Cognee recall while
  keeping resumed chat messages on explicit, read-only recall.
- Put readable issue IDs first in the interactive selector and show the current
  normalized project title when the initiative belongs to a project.
- Use the current Multica profile workspace for interactive Pi selection when
  `MULTICA_WORKSPACE_ID` is absent; keep the variable required for managed runs.
- Introduce schema v3 readable workspace, issue, project, entity, relation, and
  NodeSet identifiers while retaining UUIDs only as internal provenance.
- Use `workgraph-workspace-<workspace-slug>` datasets and a clean
  `workgraph-workspace-v3.db` pre-release cutover without replaying old stores.
- Reconcile new server-authored Multica issue activity at Pi lifecycle
  boundaries using durable server activity IDs, authoritative issue read-back,
  deterministic event IDs, and fail-closed handling of truncated history.
- Accept a root issue UUID or human-readable Multica identifier such as
  `B-184` for interactive `pi --initiative` selection.
- Show the three most recent active initiatives with readable IDs in the Pi
  selector and keep internal issue UUIDs out of agent-facing context and tools.
- Add the implementation plan for evolving the existing Pi extension to one
  Cognee dataset per Multica workspace, readable initiative NodeSets, bounded
  two-lane recall, and a generic work ontology.
- Implement that workspace memory model with strict Multica v0.4.35 identity
  resolution, deterministic server-derived NodeSets, validated recall records,
  and workspace-scoped concurrent outbox delivery.
- Preserve managed-run provenance on current Multica releases by using the
  exact agent task UUID as the run identity when no separate run UUID is
  exported, while still preferring `MULTICA_RUN_ID` when available.
- Apply the SQLite busy timeout before concurrent Pi processes negotiate WAL
  and initialize the shared outbox schema, preventing one role from losing its
  Workgraph extension during simultaneous task starts.
- Add a public quick start for Multica, Pi, Cognee Cloud, and self-hosted
  Cognee; support unauthenticated loopback Cognee for local evaluation.
- Replace the pre-release internal `brwsr-` dataset and database names with
  product-neutral Workgraph names, and use a user-writable local data directory
  by default.
- Allow callers to supply stable entity identifiers through
  `initiative_memory_remember` and align the operating contract with runtime
  behavior.
- Mark writes delivered only after synchronous Cognee ingestion reports
  completion; retain failed or ambiguous attempts for at-least-once retry.
- Send Cognee Cloud tenant identity on every remote API request.

- Replace the generic pi-cognee surface with opinionated Multica initiative
  resolution, immutable Cognee dataset scoping, Pi lifecycle recall/capture,
  a durable SQLite outbox, an exact timeline, and non-destructive memory tools.
- Document prerequisites, assumptions, authority, ontology, lifecycle,
  fallbacks, privacy, and non-goals, and verify that Multica `v0.4.35` parent
  chains resolve across project boundaries inside one workspace.
