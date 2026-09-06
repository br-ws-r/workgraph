# Architecture

Workgraph is an in-process Multica-to-Cognee bridge. It has no HTTP listener,
scheduler service, provider SDK or deployment-specific business rules.

## Module ownership

| Module | Responsibility |
| --- | --- |
| `pi.ts`, `omp.ts` | Stable host entrypoints selecting one shared extension |
| `extension.ts` | Session state, lifecycle hooks and context injection |
| `selector.ts` | Interactive initiative discovery and selection |
| `tools.ts` | Shared tool schemas and public result projection |
| `runtime.ts` | Scope validation, reconciliation and serialized delivery orchestration |
| `multica.ts` | Bounded CLI execution, JSON validation, exact task/issue resolution |
| `cognee.ts` | Authenticated HTTP transport and semantic document projection |
| `recall.ts` | Parse/validate retrieved Workgraph records; one retry for unusable chunks |
| `activity.ts` | Bounded descriptions of known Multica activity actions |
| `schema.ts` | Backend-neutral ontology, provenance and deterministic NodeSets |
| `outbox.ts` | SQLite events, delivery claims and activity baselines |
| `sqlite.ts` | Minimal native Node/Bun synchronous SQL contract |
| `config.ts` | Configuration validation, timeouts and data path |
| `doctor.ts`, `cli.ts` | Read-only deployment preflight |
| `core.ts` | Public harness-independent API |

Pi types are used for the common extension contract at build time. The OMP-specific
prompt array, timer and `session_stop` differences are adapted at the extension
boundary. These narrow casts are intentional compatibility points, covered by
host tests; they do not claim the two full SDKs are interchangeable. Neither
host's SDK is imported at runtime. TypeBox emits plain string enum tool schemas.

## Authority and scope

Multica owns workflow state, parent links and assignments. GitHub/repositories
own code and delivery state. SQLite owns the local event order and delivery
metadata. Cognee owns semantic retrieval, which is non-authoritative.

At activation the runtime locks the workspace UUID/slug, root UUID/identifier,
issue, project and parent identity. Before semantic operations it re-reads the
assigned task (when managed) and parent chain. A changed scope fails closed;
a temporary Cognee failure does not discard a successful Multica read. Status
and title can evolve; stage is read from the current issue when recording memory.
There is no heuristic task selection or cross-workspace parent traversal.

Recall uses CHUNKS containing a validated `WORKGRAPH_RECORD_V1`, optionally after
a `WORKGRAPH_GRAPH_V1` projection. The runtime filters provenance by workspace and
initiative after retrieval, bounds the result count, and exposes readable source
identifiers. Initiative and related-history lanes are presented separately.
A nonempty response with no usable Workgraph records is retried once, then
reported as unavailable. An absent Cognee configuration is also unavailable,
not a successful empty recall. Recall prompts are not copied into timeline events.

## Lifecycle

| Lifecycle | Pi | OMP | Shared behavior |
| --- | --- | --- | --- |
| Start | `session_start` | `session_start` | Resolve scope and establish activity baseline |
| Before turn | `before_agent_start` | `before_agent_start` | Fresh Multica context plus bounded recall |
| Settle | `agent_settled` | `session_stop`, deferred until idle | Reconcile activity, then local run-state event |
| Compact | `session_before_compact` | Same | Reconcile and queue a sourced compaction anchor |
| Shutdown | `session_shutdown` | Same | Cancel selector, reconcile, drain and close SQLite |

OMP selection is detached because its startup lifecycle has a deadline. The first
turn waits for selection; shutdown releases that wait even if OMP cancels the
scheduled callback. Dialog timeout is ten seconds, separately from CLI discovery
time. For managed/explicit launches there is no selector or selection timer.

## Activity reconciliation

The first successful snapshot persists a baseline of activity UUIDs without
importing old history. Later reads use `issue timeline --activity-only --output
json`, verify current scope, and append unseen server events with deterministic
`multica-activity:<uuid>` IDs. The event is committed before marking the UUID seen:
a crash between those writes safely retries the append. Competing processes keep
the first event payload; reconciliation is not a strict total order of remote
completion across processes.

Baseline initialization uses an immediate transaction. A failed initial snapshot
persists a failed state; a later process cannot silently start from a newer
baseline. A truncated subsequent window must overlap a stored activity UUID.
Recovery requires operator investigation and explicit acceptance of any gap.

Supported summaries cover Multica v0.4.35 status, priority, title, assignee type,
dates, task outcome and squad evaluation activity. This is not a full audit feed
for labels, metadata, attachments or every Multica workspace object. Unknown
actions produce a bounded generic description instead of retaining raw details.

## Delivery and storage

1. Validate a sourced record and append it before starting HTTP delivery.
2. Claim pending semantic events for the workspace in one atomic SQL statement.
3. Send each record to the dataset derived from its **stored workspace slug**.
4. A synchronous Cognee `completed` response marks it delivered under the live claim.
5. Failures preserve the payload; finally release unfinished claims immediately.

An owner UUID and lease expiry coordinate concurrent writers. After a process
crash another writer can reclaim expired work. Each process serializes flushes;
there is no cross-server scheduler, guaranteed global delivery order or exactly-once
ingestion. The same SQLite file works under Node and Bun using their built-in
SQLite implementations. WAL, a busy timeout, and conditional ownership updates
are shared SQL rather than host-specific copies.

Event payloads are append-only. Delivery attempts, timestamps and bounded errors
are mutable metadata. Pending counts use SQL COUNT over semantic records only;
local-only lifecycle events have no delivery timestamp by design. Timeline limits
bound returned rows, independently of backlog counts.

## Configuration boundaries

One process snapshots one launch environment. Validate Cognee configuration before
opening SQLite. Multica commands receive that same environment and execute with
`execFile`, never shell interpolation. CLI responses have a 10-second per-command
timeout and a 64 MiB buffer (task history can be large). Parent and list traversal
have separate count bounds, not one total wall-clock deadline.

The Cognee base URL may include a reverse proxy prefix, but not credentials,
query parameters, fragments or `/api/v1`. Redirects fail rather than forwarding
custom authentication headers. HTTP error bodies are omitted from errors so an
upstream diagnostic page is not persisted verbatim in the outbox.

Keep local data tied to one Multica deployment and one Cognee backend/tenant.
The current schema does not record a transport destination or authorize tenants;
changing those environment settings is an operator-controlled migration, not an
automatic replication mechanism. See [deployment.md](deployment.md).
