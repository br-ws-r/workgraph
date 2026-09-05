# Changelog

## Unreleased

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
