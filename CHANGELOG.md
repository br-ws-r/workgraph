# Changelog

## Unreleased

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
