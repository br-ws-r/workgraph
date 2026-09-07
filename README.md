# Workgraph

A generic bridge between [Multica](https://github.com/multica-ai/multica) workflow
state and [Cognee](https://github.com/topoteretes/cognee) semantic memory.
Workgraph runs inside the agent harness; it is not another server to operate.

**OMP is the primary integration direction. Pi remains supported.** Both
[Oh My Pi](https://github.com/can1357/oh-my-pi) and
[Pi](https://github.com/earendil-works/pi) use the same runtime, tools, record
schema, workspace datasets, and durable SQLite outbox. Switching harnesses does
not require a memory migration.

> Experimental, pre-1.0. The package is installable from GitHub or a built npm
> tarball and is not published to a registry. `private: true` prevents accidental
> npm publication; it does not make this GitHub repository private.

## What it does

- Resolves a managed task or selected issue through Multica's persisted parent chain.
- Uses the verified workspace's Cognee dataset and the root issue's initiative NodeSet.
- Recalls current-initiative context and bounded related workspace history.
- Records sourced decisions, blockers, artifacts, evidence, and compaction anchors.
- Reconciles new Multica activity and keeps an exact local event timeline.
- Queues semantic writes durably when Cognee is unavailable.

Multica remains authoritative for assignments and workflow state. Cognee recall
is historical context that an agent must verify. Workgraph does not synchronize
GitHub, capture arbitrary tool output, archive conversations, or manage Cognee's
inference providers. Its ontology describes work, not a particular company,
repository, server, or development process.

## Scope and isolation

```text
Multica task -> assigned issue -> parent chain -> root initiative
                  |                                |
           verified workspace             initiative:WG-184 NodeSet
                  |
       workgraph-workspace-<workspace-slug> Cognee dataset
```

The workspace is the dataset boundary. Initiative, project and stage NodeSets
are semantic filters, not access controls. Parent traversal can cross projects
within the same workspace and rejects cycles and chains deeper than 32 parents.
An initiative process locks its scope and revalidates Multica before semantic
operations. It never infers scope from a repository, prompt, branch or title.

Without a verified initiative, writes and timeline access are disabled. Verified
Multica workspace chats additionally support bounded, read-only workspace recall:
once before the first turn of a fresh session, then on demand. Resuming a chat
does not repeat the automatic recall on every message.

Use separate Cognee tenants/instances and separate local data directories for
independent Multica deployments that may reuse workspace slugs. A dataset name
is not a substitute for Cognee authentication or authorization.

## Requirements

| Component | Compatibility baseline |
| --- | --- |
| Node.js | **22.19.0+**, required for npm builds, CLI and Pi; CI also runs Node 24 |
| OMP | Adapter targets **18.1.11**, with **Bun 1.3.14+**; uses `bun:sqlite` |
| Pi | `@earendil-works/pi-coding-agent` **0.84.4**; uses `node:sqlite` |
| Multica CLI | JSON contract verified against **v0.4.35** |
| Cognee | Cloud or self-hosted HTTP API with `/api/v1/remember` and `/api/v1/recall` |

These are compatibility baselines, not guarantees about every later upstream
release. CI exercises the adapters, Node/Bun storage and packaged HTTP transport;
production credentials and a live managed run require the deployment acceptance
check in [deployment.md](docs/deployment.md#acceptance-check).

Install your harness from its official guide:
[OMP](https://github.com/can1357/oh-my-pi/tree/v18.1.11#install) or
[Pi](https://github.com/earendil-works/pi). Authenticate the
[Multica CLI](https://github.com/multica-ai/multica/blob/v0.4.35/CLI_INSTALL.md)
against the intended server **as the OS user that launches the agents**.

## Install on a server

Choose an approved commit from this repository. The server needs Git access to
the source; if the repository is private, configure a read-only deploy key or a
credential helper first. Do not embed tokens in package URLs.

```bash
# An application directory owned by the agent service user.
mkdir -p "$HOME/workgraph-install"
cd "$HOME/workgraph-install"
npm init -y
# Replace the placeholder with the approved full Git commit SHA.
npm install --save-exact 'git+https://github.com/br-ws-r/workgraph.git#<commit-sha>'

# Register the installed package with the harness used on this server.
omp plugin link "$PWD/node_modules/@br-ws-r/workgraph"
# Pi remains supported; use this instead for a Pi installation:
# pi install "$PWD/node_modules/@br-ws-r/workgraph"
```

Git installation runs the package's `prepare` build. Keep the resulting
application manifest and lockfile, and keep the installation directory in place:
host registration points to it. Restart the harness after upgrades.

For a prebuilt tarball, private repository access, repeatable deployment with
`npm ci`, GitHub Packages, and rollback, see
[distribution and deployment](docs/deployment.md). No registry publication is
needed for this route.

`npx`/`npm exec` runs the diagnostic CLI. Memory itself runs inside OMP or Pi:

```bash
npx --no-install workgraph doctor
npx --no-install workgraph doctor --online --json
```

The default check reads configuration and checks the directory; it creates no
SQLite database and performs no network calls. `--online` also reads the Multica
workspace and calls Cognee health. Errors exit `1`, warnings exit `0`, and invalid
CLI arguments exit `2`. A health response does not prove dataset access or
successful ingestion.

## Configure Cognee

Export settings in the environment of the **agent process**, not just an
administrator's shell. [`.env.example`](.env.example) is a template; Workgraph does
not automatically load dotenv files. Never commit real credentials.

### Self-hosted (recommended deployment direction)

Deploy Cognee using its [REST API guide](https://docs.cognee.ai/guides/deploy-rest-api-server).
Configure its persistent storage, graph, embedding and LLM providers there. For
an authenticated instance, enable Cognee authentication and obtain a bearer token
using its documented login endpoint:

```bash
export COGNEE_SERVICE_URL="https://cognee.example.com"
export COGNEE_AUTH_SCHEME="bearer"
export COGNEE_API_KEY="your-bearer-token"
unset COGNEE_TENANT_ID
export WORKGRAPH_DATA_DIR="$HOME/.local/share/workgraph"
mkdir -p "$WORKGRAPH_DATA_DIR"
chmod 700 "$WORKGRAPH_DATA_DIR"
```

For loopback development only, use `http://127.0.0.1:8000` with
`COGNEE_AUTH_SCHEME=none` and unset the key. The client supports reverse-proxy base
paths such as `https://example.com/cognee/`; omit `/api/v1`. Redirects are rejected,
so configure the final endpoint. Private CA certificates can use Node's standard
`NODE_EXTRA_CA_CERTS`; configure and verify trust in your OMP/Bun environment too.

Self-hosted storage does not imply local inference. Cognee can still send records
to external LLM or embedding providers. Workgraph neither selects nor hosts those
providers. See the [operations guide](docs/deployment.md#self-hosted-operations).

### Cognee Cloud

Use the API Base URL, API key and Tenant ID from Cognee's
[connection details](https://docs.cognee.ai/cognee-cloud/ui/api-keys):

```bash
export COGNEE_SERVICE_URL="https://your-tenant.aws.cognee.ai"
export COGNEE_AUTH_SCHEME="x-api-key"
export COGNEE_API_KEY="your-api-key"
export COGNEE_TENANT_ID="your-tenant-id"
```

Cloud and self-hosted use the same record and HTTP contracts.

## Select an initiative

```bash
multica version
multica auth status
# Select the correct workspace through the Multica CLI, then:
omp --initiative WG-184
# Or: pi --initiative WG-184
```

Use a **root** issue's readable identifier. UUID input remains available for
diagnostics. Interactive runs without the flag offer three recent active roots
and manual entry. OMP detaches the selector from `session_start`, with a ten-second
UI dialog timeout defaulting to No initiative. Multica discovery happens before
the dialog and can take longer; use explicit scope for unattended launches.

Ask the agent to call `initiative_memory_status`. It should report `initiative`,
the expected dataset and readable identifiers, and `cogneeConfigured: true`.

### Managed Multica runs

Multica supplies the launch identity:

```text
MULTICA_WORKSPACE_ID=<workspace-uuid>
MULTICA_TASK_ID=<task-uuid>
MULTICA_AGENT_ID=<agent-uuid>
MULTICA_RUN_ID=<optional-distinct-run-uuid>
```

Workgraph finds the exact task with `multica agent tasks`, resolves its issue and
walks to the root. The task UUID is the fallback run identity. `--initiative`
cannot override a managed issue task. `MULTICA_ISSUE_ID` also supports explicitly
issue-scoped launches. Start one harness process per managed run.

## Tools (OMP and Pi)

These tools have the same memory contract in Pi and OMP. A successful
`initiative_memory_remember` returns `event_id`, `entity_identifier`, and
`delivery: "queued"`. Keep the event ID and check
`initiative_timeline({"event_id":"<returned event ID>"})` until its delivery is
`delivered`. Queued acknowledges local persistence only. Use Cognee recall
separately to verify remote readability.

`initiative_timeline` is explicitly labelled `storage: "local_outbox"`. Its
optional exact `event_id` and `entity_identifier` filters run before the limit,
so an older write is not hidden behind recent status events. `records: "explicit"`
shows authored memory; `records: "activity"` shows automatic Multica activity.
The default `all` view retains the full audit timeline. Graph relations and
NodeSets are included for inspection.

For a known entity, use
`initiative_memory_recall({"query":"<identifier or descriptive terms>","entity_identifier":"<exact ID>"})`.
This mode requires the active initiative, returns only matching Cognee records,
and can retry once with the locally stored label/summary. Without that local
record, provide descriptive terms yourself. The retry improves semantic
retrieval; it is not a guaranteed remote key lookup. An empty response remains
empty even when the local timeline says delivered. No new store or unrestricted
Cognee query is introduced.

For a reproducible six-agent evaluation, use the
[live relay protocol](docs/memory-relay-eval.md).

| Tool | Purpose |
| --- | --- |
| `initiative_memory_status` | Scope, configured backend and exact pending semantic delivery count |
| `initiative_memory_recall` | Current initiative, related workspace history, or read-only chat recall |
| `initiative_memory_remember` | Queue a bounded, sourced semantic record |
| `initiative_timeline` | Fresh scope verification followed by exact ordered local events |

No tool accepts a dataset. Remember accepts a stable `entity_identifier` and
`entity_label` when multiple records describe the same entity. Otherwise it creates
a readable, timestamped identifier. Use relation targets such as `issue:WG-184`;
bare issue identifiers are normalized. Full UUIDs are rejected in semantic
identifiers, labels and NodeSets but retained as internal provenance.

Remember returns `queued` after durable local insertion, not remote completion.
Timeline delivery metadata distinguishes `pending` and `delivered`. Pending counts
exclude local-only events and include the full backlog, even beyond 500 records.

## Configuration reference

| Variable | Default / purpose |
| --- | --- |
| `COGNEE_SERVICE_URL` | Unset disables Cognee; HTTP(S) base URL, without `/api/v1` |
| `COGNEE_AUTH_SCHEME` | `x-api-key`; also `bearer` or `none` |
| `COGNEE_API_KEY` | Required except for `none`; key or bearer token |
| `COGNEE_TENANT_ID` | Cloud tenant sent as `X-Tenant-Id`; normally unset for self-hosted |
| `WORKGRAPH_COGNEE_TIMEOUT_MS` | `3000`; health/recall HTTP timeout |
| `WORKGRAPH_COGNEE_REMEMBER_TIMEOUT_MS` | `120000`; ingestion request and delivery batch budget |
| `WORKGRAPH_DATA_DIR` | `$XDG_DATA_HOME/workgraph`, otherwise `~/.local/share/workgraph` |
| `MULTICA_WORKSPACE_ID` | Required for managed runs and workspace chat recall |
| `MULTICA_TASK_ID`, `MULTICA_AGENT_ID` | Exact managed task and agent; provided together |
| `MULTICA_RUN_ID` | Optional run identity; takes precedence over task UUID |
| `MULTICA_ISSUE_ID` | Explicit issue when no managed task is supplied |
| `MULTICA_BIN` | `multica`; executable path, not a command with shell arguments |

Timeouts must be whole milliseconds between 100 and 2147483647. A supplied but
invalid Cognee configuration is an explicit error, not silently disabled memory.
Pi and OMP isolate initialization failures at the extension boundary: the host
continues with an explicit unavailable warning, a diagnostic
`initiative_memory_status` tool, and no Workgraph recall/write tools. Headless
runs also receive unavailable-memory context before agent turns. Raw exception
text and credential values are not exposed by this fallback. Core runtime
construction and `workgraph doctor` retain strict validation; authentication is
never changed to `none` automatically. Restore the authenticated launch
environment and restart to enable memory. No outbox is opened for a missing-key
configuration, and existing queued records are preserved.

The runtime snapshots its launch environment; restart after configuration or token
changes. Multica subprocesses receive that same environment and use the CLI's own
server/authentication settings. Workgraph has no separate Multica API credentials.

## Durability, privacy and limitations

SQLite stores the exact local timeline and pending payloads in
`workgraph-workspace-v3.db`. Use persistent **local** storage. Several processes
can share it on one host; separate servers have separate exact timelines even
when they share Cognee. Do not use SQLite WAL on a network filesystem.

Semantic delivery is at least once. An `Idempotency-Key` is sent, but Cognee does
not document deduplication guarantees for it. An ambiguous timeout can produce
remote duplicates. Writes retry at startup, settlement, later writes and shutdown; there is no
standalone background delivery daemon. Abrupt termination leaves pending records
and expiring claims for a later process.

No raw tool output is captured automatically. Content limits are **not secret or
PII redaction**: agents and operators must keep secrets, personal data, transcripts,
full files and diffs out of summaries. Workgraph offers no destructive Cognee tools.

The v3 store does not migrate earlier pre-release SQLite schemas or UUID-named
Cognee datasets. Existing v3 stores remain compatible. A workspace slug rename
changes the dataset for new processes; pending records retain their original
dataset. See [backup, upgrade and recovery](docs/deployment.md#backup-upgrade-and-recovery).

## Development and design

```bash
npm ci
npm run check
# With Bun 1.3.14+ on PATH:
node scripts/package-smoke.mjs --bun
# Check Git prepare/install from the committed HEAD:
node scripts/package-smoke.mjs --git
```

`check` typechecks, runs regression tests, builds, packs and installs the artifact
in an empty consumer, then tests its CLI, adapter loading, SQLite claims and HTTP
delivery. Production installation needs only Zod and TypeBox; Pi is an optional
peer for extension types and a development dependency for compatibility checks.
`@br-ws-r/workgraph/core` exposes the runtime without a harness entrypoint.

- [Architecture and lifecycle](docs/architecture.md)
- [Distribution, self-hosting and recovery](docs/deployment.md)
- [Repository review and remaining work](docs/review-2026-09.md)
- [Record ontology](docs/initiative-memory-ontology.md)
- [Original workspace-memory design plan](docs/workspace-memory-plan.md)

Workgraph derives from [`@kerryhatcher/pi-cognee`](https://github.com/kerryhatcher/pi-cognee)
and retains the upstream MIT [license](LICENSE).
