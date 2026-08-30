# Workgraph

Workgraph is an opinionated initiative-scoped knowledge graph and durable agent
memory. It deliberately assumes **Pi** as the agent runtime, **Multica** as the
authoritative workflow system, and **Cognee** as the semantic memory backend.
It is not a generic personal-memory package.

Multica owns initiatives, issues, tasks, assignment, workflow state, runs, and
handoffs. GitHub owns pull-request and delivery state. Workgraph stores bounded
context, provenance, relationships, and a chronological delivery outbox; it
must never override fresh Multica or GitHub state.

## Core contract

- One root Multica issue UUID maps to exactly one Cognee dataset:
  `brwsr-initiative-<uuid>`.
- A Pi process locks one verified initiative at `session_start`. It cannot
  switch datasets later.
- Managed runs resolve `MULTICA_TASK_ID` through Multica's read-only task and
  persisted parent chain. Interactive Pi can use `--initiative <root-uuid>` or
  choose a recent root issue.
- Unavailable or ambiguous Multica state becomes `No initiative`: Pi continues,
  while all recall and writes remain disabled.
- Cognee failures never block Pi. Pending writes remain in the SQLite outbox.
- No delete, global recall, arbitrary dataset, transcript, or unrestricted tool
  capture operation is exposed.

## Runtime configuration

Credentials are accepted only from the process environment:

```text
COGNEE_SERVICE_URL=https://api.cognee.ai
COGNEE_API_KEY=<secret>
COGNEE_AUTH_SCHEME=x-api-key
WORKGRAPH_DATA_DIR=/srv/data/cognee/outbox
```

For an authenticated self-hosted service, use its loopback URL and set
`COGNEE_AUTH_SCHEME=bearer` when the credential is a bearer token. Do not put
credentials in Pi JSON, the repository, or the outbox.

Install as a Pi package after building:

```bash
npm ci
npm run check
pi install /absolute/path/to/workgraph
```

Workgraph registers `initiative_memory_status`, `initiative_memory_recall`,
`initiative_memory_remember`, and `initiative_timeline`. None accepts a dataset
parameter.

## Cognee client decision

The public `@cognee/cognee-ts` releases are embedded Rust/Neon bindings. They
do not export the documented `serve({ url, apiKey })`; upstream places that
remote bridge in a closed cloud package. Workgraph therefore uses Cognee's
official `/api/v1` HTTP API through a small typed transport. It implements no
retrieval, embeddings, graph extraction, or ontology engine. Endpoint-routing
tests prove every semantic operation uses `COGNEE_SERVICE_URL` and the locked
dataset. A future public remote SDK can replace this transport without changing
the Workgraph runtime contract.

## Development

```bash
npm ci
npm run check
```

The canonical vocabulary and record envelope are documented in
[`docs/initiative-memory-ontology.md`](docs/initiative-memory-ontology.md).

## Provenance

This repository is a fork of `@kerryhatcher/pi-cognee` and retains its MIT
license. Workgraph replaces the upstream generic SDK/MCP and destructive tool
surface with the initiative-scoped architecture described above.
