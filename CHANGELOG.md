# Changelog

## Unreleased

- Add the implementation plan for a single universal Workgraph MCP core shared
  by Pi, Claude Code, and other MCP-capable Multica agents, using one dataset per
  workspace, readable initiative NodeSets, bounded cross-initiative recall, and
  a workflow plus engineering-work ontology.
- Preserve managed-run provenance on current Multica releases by using the
  exact agent task UUID as the run identity when no separate run UUID is
  exported, while still preferring `MULTICA_RUN_ID` when available.
- Allow deployments to configure the initiative dataset prefix without
  changing the default public `workgraph-initiative-` namespace.
- Apply the SQLite busy timeout before concurrent Pi processes negotiate WAL
  and initialize the shared outbox schema, preventing one role from losing its
  Workgraph extension during simultaneous task starts.
- Add a public quick start for Multica, Pi, Cognee Cloud, and self-hosted
  Cognee; support unauthenticated loopback Cognee for local evaluation.
- Replace the pre-release internal `brwsr-` dataset and database names with
  product-neutral Workgraph names, and use a user-writable local data directory
  by default.
- Allow callers to supply stable entity IDs through
  `initiative_memory_remember` and align the operating contract with runtime
  behavior.
- Ask Cognee to process remembered records in the background and document the
  at-least-once delivery boundary accurately.
- Send Cognee Cloud tenant identity on every remote API request.

- Replace the generic pi-cognee surface with opinionated Multica initiative
  resolution, immutable Cognee dataset scoping, Pi lifecycle recall/capture,
  a durable SQLite outbox, an exact timeline, and non-destructive memory tools.
- Document prerequisites, assumptions, authority, ontology, lifecycle,
  fallbacks, privacy, and non-goals, and verify that Multica `v0.4.35` parent
  chains resolve across project boundaries inside one workspace.
