# Workgraph

Workgraph is an opinionated initiative-scoped knowledge graph and durable agent
memory. It deliberately assumes **Pi** as the agent runtime, **Multica** as the
authoritative workflow system, and **Cognee** as the semantic memory backend.
It is not a generic personal-memory package.

Multica owns initiatives, issues, tasks, assignment, workflow state, runs, and
handoffs. GitHub owns pull-request and delivery state. Workgraph stores bounded
context, provenance, relationships, and a chronological delivery outbox; it
must never override fresh Multica or GitHub state.

## Prerequisites

Workgraph is intentionally not a drop-in memory plugin. A supported deployment
requires all of the following:

- Node.js 22 or newer. The durable outbox uses the built-in `node:sqlite`
  module; no embedded Cognee database or native SQLite add-on is installed.
- Pi with the `session_start`, `before_agent_start`, `agent_settled`,
  `session_before_compact`, and `session_shutdown` extension events.
- An authenticated Multica CLI. Compatibility is verified against `v0.4.35`;
  another version must pass the resolver and cross-project integration tests
  before deployment. Managed runs must provide
  `MULTICA_WORKSPACE_ID`, `MULTICA_TASK_ID`, `MULTICA_RUN_ID`, and
  `MULTICA_AGENT_ID`.
- A central Cognee API reachable through `COGNEE_SERVICE_URL`, with a dedicated
  API credential. It can be Cognee Cloud for a non-sensitive evaluation or a
  loopback-only self-hosted service.
- A writable, persistent `WORKGRAPH_DATA_DIR`. Production deployments should
  place it under `/srv/data`; ephemeral process or repository directories are
  not supported as durable memory.
- One new Pi process per Multica run. Initiative scope is immutable for the
  lifetime of the process and is never switched in-place.

Pi and the Multica CLI remain usable when Cognee is unavailable. Multica must
be reachable only while selecting or refreshing authoritative initiative
state; a failure disables memory for that operation rather than disabling Pi.

## Assumptions and boundaries

- A Multica issue UUID is stable and globally identifies the issue.
- `parent_issue_id` is the canonical initiative hierarchy. Workgraph never
  reconstructs hierarchy from project, repository, branch, CWD, issue title,
  prompt text, semantic similarity, or a previously selected dataset.
- Every parent in a chain belongs to the same Multica workspace. Cross-project
  links inside that workspace are supported; cross-workspace parent links are
  not.
- The maximum accepted parent depth is 32 and cycles fail closed.
- Project and repository identity are record properties. Neither creates a
  memory namespace.
- Cognee extraction is useful but not deterministic across model or backend
  versions. SQLite is therefore the exact delivery and chronology source.
- Workgraph does not provide workflow, task routing, assignment, approval,
  locking, or PR state. Those remain native Multica and GitHub concerns.

## Verified Multica cross-project hierarchy

Cross-project root resolution is supported by the pinned Multica `v0.4.35`
model. Multica validates `parent_issue_id` and `project_id` independently
against the same workspace. When a child omits `project_id`, it inherits the
parent project; when it supplies an explicit project, that project overrides
the parent project without removing the parent link.

This is covered upstream by
[`TestCreateSubIssueUsesExplicitProjectOverParentProject`](https://github.com/multica-ai/multica/blob/v0.4.35/server/internal/handler/handler_test.go)
and by the independent parent/project validation in the
[`IssueService`](https://github.com/multica-ai/multica/blob/v0.4.35/server/internal/service/issue.go).
Multica's
[`issue-detail.tsx`](https://github.com/multica-ai/multica/blob/v0.4.35/packages/views/issues/components/issue-detail.tsx)
also documents `project_id` and `parent_issue_id` as orthogonal. The CLI accepts
both `--parent <issue>` and `--project <project>` on issue creation and update.

Workgraph consequently follows this persisted chain without consulting project
identity:

```text
task in project storefront
  -> child issue (project storefront)
  -> parent issue (project billing)
  -> root issue UUID
  -> brwsr-initiative-<root-uuid>
```

The boundary is the workspace, not the project. Multica rejects a parent or
project outside the selected workspace, and Workgraph passes the same
`MULTICA_WORKSPACE_ID` on every read. An explicit `initiative_id` metadata
fallback is therefore not required for cross-project initiatives on Multica
`v0.4.35`.

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

## Authority model

Workgraph has no authority to mutate or reinterpret operational state:

| Information | Authority | Workgraph treatment |
| --- | --- | --- |
| Initiative hierarchy, issue/task state, assignee, run, handoff | Multica | Fresh read-back always wins |
| Repository revision, pull request, checks, delivery evidence | GitHub and repository | Fresh read-back always wins |
| Exact event order and Cognee delivery status | Workgraph SQLite outbox | Read through `initiative_timeline` |
| Semantic context and extracted relationships | Cognee | Non-authoritative recall lead |

`confirmed` in a memory record means that its source was confirmed when
observed. It does not make a stale record stronger than a later Multica or
GitHub read-back.

## Initiative and dataset identity

The root Multica issue UUID is the only dataset key:

```text
initiative_id = canonical root issue UUID
dataset       = brwsr-initiative-<initiative_id>
```

All agents, repositories, projects, tasks, sessions, and runs belonging to the
same initiative share that dataset. They remain distinguishable through record
properties such as `agent_id`, `task_id`, `run_id`, repository, and source.
Workgraph never exposes a dataset argument to Pi tools.

Managed Pi resolves exactly one task from `multica agent tasks <agent-id>`,
loads its issue, and follows persisted parents to the root. Interactive Pi
accepts a verified root through `--initiative <uuid>` or offers recent active
roots from Multica. Passing a child to `--initiative` is rejected.

## Ontology

The canonical backend-neutral ontology lives in
[`docs/initiative-memory-ontology.md`](docs/initiative-memory-ontology.md) and
the executable validators in [`src/schema.ts`](src/schema.ts). It is owned by
Workgraph, not inferred back from Cognee.

Entity types are `Issue`, `Task`, `Agent`, `Squad`, `Handoff`, `Decision`,
`Blocker`, `Artifact`, `Repository`, `Run`, `Evidence`, and `Conflict`.
Relations include hierarchy, ownership, delegation, dependencies, production,
evidence, implementation, and observation. Every permanent record includes a
stable entity ID, root initiative ID, bounded summary, source, observation
timestamp, authority, and typed relations.

Authority levels are:

- `observed`: bounded direct read-back;
- `confirmed`: explicitly verified evidence or settled decision;
- `proposed`: proposal not yet reflected in authoritative state; and
- `inferred`: semantic or model-derived interpretation.

The first release uses Cognee's default graph extraction over these structured
records. It does not install a custom Cognee graph model. A custom model is
appropriate only after evaluation demonstrates inconsistent mapping, and its
definition must be versioned in this repository.

## Pi lifecycle

| Event | Workgraph behavior |
| --- | --- |
| `session_start` | Connect the API client, resolve and verify one root, lock the dataset, report status |
| `before_agent_start` | Refresh Multica, recall only the locked dataset, inject bounded separated context |
| `agent_settled` | Refresh Multica, append a bounded run summary, attempt idempotent delivery |
| `session_before_compact` | Append a bounded decision/blocker/change/next-step anchor without blocking compaction |
| `session_shutdown` | Time-bound pending delivery flush and close SQLite |

General `tool_execution_end` capture is intentionally absent. Shell output,
arbitrary tool traces, whole files, and full diffs are not memory inputs.

## Manual tools

- `initiative_memory_status`: show the immutable initiative, dataset, backend,
  and outbox state without changing them.
- `initiative_memory_recall`: semantic search only inside the locked dataset.
- `initiative_memory_remember`: store one bounded sourced record in the locked
  initiative.
- `initiative_timeline`: read exact ordered events and delivery state directly
  from SQLite.

The tools expose no delete, forget, dataset-selection, global search, raw
query, or graph-administration operation. Write behavior is unavailable under
`No initiative`.

## Durable outbox and timeline

SQLite is both an append-only audit and a delivery outbox. Each event records
its stable event ID, timestamp, workspace, initiative, task, run, agent, type,
bounded summary, source, source revision, authority, and payload hash. A unique
event ID makes retries idempotent, while WAL mode and a busy timeout allow
multiple Pi processes to append safely.

Failed Cognee deliveries retain their payload, attempt count, and bounded
error. Restarting Pi or Cognee does not discard them. The outbox can reingest
bounded records during Cloud-to-self-hosted migration, but it cannot guarantee
a bit-identical extracted Cognee graph.

## Failure behavior and fallbacks

| Failure | Result |
| --- | --- |
| Missing task/agent identity | Interactive selection, otherwise `No initiative` |
| Invalid, ambiguous, cyclic, or inaccessible parent chain | `No initiative`; Pi continues |
| Cancelled interactive selection | `No initiative`; no last-dataset reuse |
| Cognee timeout/outage | Recall omitted; Pi continues; pending writes stay in SQLite |
| Multica refresh contradicts locked root | Memory operation fails closed; process never switches datasets |
| Stale Cognee claim | Fresh Multica/GitHub state wins |

There is no shared, workspace, agent, project, repository, ad-hoc, or
last-used fallback dataset.

## Security and privacy

- Credentials are environment-only and must never enter Pi configuration,
  repository files, summaries, SQLite, or logs.
- Permanent records must not contain secrets, authentication state, personal
  data, raw transcripts, raw tool output, shell logs, whole files, or full
  diffs.
- Self-hosted storage does not imply local inference. When Cognee uses an
  external LLM or embedding provider, bounded records leave the host during
  inference and require an explicit privacy decision.
- Production APIs should bind to loopback, require authentication, and be
  accessed through an SSH tunnel or another reviewed private boundary.
- Workgraph deliberately exposes no destructive memory operation.

## Runtime configuration

Credentials are accepted only from the process environment:

```text
COGNEE_SERVICE_URL=https://your-tenant.aws.cognee.ai
COGNEE_API_KEY=<secret>
COGNEE_TENANT_ID=<tenant-id>
COGNEE_AUTH_SCHEME=x-api-key
WORKGRAPH_DATA_DIR=/srv/data/cognee/outbox
```

Cognee Cloud requires the tenant-specific API base URL and sends both
`X-Api-Key` and `X-Tenant-Id` on every API request. For an authenticated
self-hosted service, use its loopback URL, omit `COGNEE_TENANT_ID`, and set
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

The test suite covers dataset derivation, parent-chain and exact-task
resolution, cross-project traversal, root immutability, no-initiative behavior,
outbox ordering/idempotency, endpoint routing, and outage-safe delivery.

## Non-goals

Workgraph does not implement embeddings, retrieval algorithms, semantic graph
extraction, a general ontology engine, Multica workflow, GitHub synchronization,
transcript archiving, personal memory, or deterministic replay of a Cognee
graph. It also does not attempt to make Pi, Multica, or Cognee optional in its
first supported architecture.

## Provenance

This repository is a fork of `@kerryhatcher/pi-cognee` and retains its MIT
license. Workgraph replaces the upstream generic SDK/MCP and destructive tool
surface with the initiative-scoped architecture described above.
