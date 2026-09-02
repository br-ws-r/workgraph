# Workgraph

Initiative-scoped knowledge graph and durable memory for
[Multica](https://github.com/multica-ai/multica) agents running
[Pi](https://github.com/earendil-works/pi), backed by
[Cognee](https://github.com/topoteretes/cognee).

> **Status: experimental.** Workgraph is ready for evaluation, but its public
> configuration and data format may still change before `1.0`.

Multica already knows which issues, tasks, agents, and runs belong to a piece of
work. Cognee can turn bounded records into searchable semantic memory. Workgraph
connects the two: it resolves a Pi run to the root Multica issue, gives that
initiative one isolated Cognee dataset, and keeps an exact local delivery
timeline in SQLite.

Use Workgraph when several Pi runs, repositories, or Multica projects contribute
to one initiative and should share context without sharing all agent memory.
Workgraph is not a generic personal-memory plugin.

## What it does

- Resolves the current task or issue through Multica's persisted parent chain.
- Maps the root issue UUID to `workgraph-initiative-<root-uuid>` in Cognee.
- Locks that dataset for the lifetime of the Pi process.
- Recalls bounded semantic context before each agent turn.
- Records sourced decisions, blockers, artifacts, evidence, and run summaries.
- Keeps writes in a durable SQLite outbox when Cognee is unavailable.
- Exposes an exact initiative timeline separately from Cognee's
  non-deterministic graph extraction.

Workgraph does **not** replace Multica workflow state, assignment, or handoffs.
It does not synchronize GitHub state, archive transcripts, capture arbitrary
tool output, or expose global search and destructive memory tools.

## How scope works

```text
Multica task
  -> issue
  -> parent issue (possibly in another project)
  -> root issue UUID
  -> Cognee dataset: workgraph-initiative-<root-uuid>
```

The Multica workspace is the security boundary. Projects and repositories are
record properties, not memory namespaces. A process that cannot verify one root
enters `No initiative` mode: Pi remains usable, but recall, timeline access, and
writes are disabled.

## Prerequisites

- Node.js 22 or newer. CI currently tests Node.js 24.
- A compatible Pi installation. This package currently targets
  `@earendil-works/pi-coding-agent` `>=0.84.4`.
- An authenticated Multica CLI. The resolver is verified against Multica
  `v0.4.35`; test another version before production use.
- Cognee Cloud, or a reachable self-hosted Cognee HTTP API.

For a first evaluation, use Cognee Cloud and interactive Pi. A managed Multica
run can be connected after the interactive path works.

## Quick start with Cognee Cloud

### 1. Prepare Multica and Pi

Install and authenticate the Multica CLI using its
[official setup guide](https://github.com/multica-ai/multica/blob/main/CLI_INSTALL.md),
and install the compatible Pi distribution if needed:

```bash
npm install --global @earendil-works/pi-coding-agent@0.84.4
```

Then confirm that both commands are available:

```bash
multica version
multica auth status
pi --version
```

Select the workspace containing the initiative you want to use. Workgraph can
follow parent links across projects, but every issue in the chain must belong to
the same workspace. `multica workspace list` shows the available workspaces and
`multica workspace switch <id-or-slug>` selects one.

### 2. Clone and install Workgraph

Workgraph is not published to npm yet, so install it from a local clone:

```bash
git clone https://github.com/br-ws-r/workgraph.git
cd workgraph
npm ci
npm run check
pi install "$PWD"
```

Restart Pi after installation if it was already running.

### 3. Configure Cognee Cloud

In the Cognee Cloud dashboard, create an API key and copy the **API Base URL**
and **Tenant ID** shown under Connection Details. Export them in the environment
that launches Pi:

```bash
export COGNEE_SERVICE_URL="https://your-tenant.aws.cognee.ai"
export COGNEE_API_KEY="your-api-key"
export COGNEE_TENANT_ID="your-tenant-id"
export COGNEE_AUTH_SCHEME="x-api-key"
```

Keep the key in your shell's secret manager or runtime environment; do not put
it in Pi configuration, this repository, prompts, or the SQLite outbox.

You can check the connection independently before starting Pi:

```bash
curl --fail --silent --show-error \
  -H "X-Api-Key: $COGNEE_API_KEY" \
  -H "X-Tenant-Id: $COGNEE_TENANT_ID" \
  "$COGNEE_SERVICE_URL/health"
```

Cognee documents these values in its
[Cloud API-key guide](https://docs.cognee.ai/cognee-cloud/ui/api-keys).

### 4. Start an interactive initiative

Run Pi with the UUID of a **root** Multica issue:

```bash
pi --initiative 00000000-0000-4000-8000-000000000001
```

If you omit `--initiative` in an interactive terminal, Workgraph offers recent
active root issues from the selected Multica workspace. A child issue is
rejected because it could make dataset selection ambiguous to a human operator.

Ask Pi to call `initiative_memory_status`. A working setup reports:

- `mode: "initiative"`;
- the expected root UUID and `workgraph-initiative-...` dataset;
- `cogneeConfigured: true`.

You can then ask Pi to remember a sourced decision and recall it later. Cognee
ingestion runs in the background and can take time. `initiative_timeline` shows
the exact local event and whether Cognee accepted it for processing; acceptance
does not mean graph extraction has already completed.

## Managed Multica runs

When Multica launches Pi for a task, Workgraph resolves the assigned task rather
than asking a person to select an initiative. The process environment must
contain:

```text
MULTICA_WORKSPACE_ID=<workspace-uuid>
MULTICA_TASK_ID=<task-uuid>
MULTICA_AGENT_ID=<agent-uuid>
# Optional when the runtime exposes a distinct run UUID; otherwise Workgraph
# uses the exact MULTICA_TASK_ID as the run identity.
MULTICA_RUN_ID=<run-uuid>
```

Workgraph runs `multica agent tasks <agent-id>` to find the exact task, reads its
issue, and follows `parent_issue_id` to the root. Start one new Pi process per
Multica run; initiative scope is intentionally immutable in-process.

`MULTICA_ISSUE_ID` is also supported for an explicitly issue-scoped launch.
`MULTICA_BIN` can point to a non-default Multica CLI binary.

## Self-hosted Cognee

Follow Cognee's
[REST API deployment guide](https://docs.cognee.ai/guides/deploy-rest-api-server)
to configure its database, graph, embedding, and LLM providers. Workgraph only
calls the HTTP API; inference and storage are Cognee concerns.

### Local evaluation without Cognee authentication

Only use this mode on loopback or another trusted development boundary:

```bash
export COGNEE_SERVICE_URL="http://127.0.0.1:8000"
export COGNEE_AUTH_SCHEME="none"
unset COGNEE_API_KEY COGNEE_TENANT_ID
```

### Authenticated self-hosted Cognee

Set `REQUIRE_AUTHENTICATION=true` in Cognee, register a user, and obtain a token
from `POST /api/v1/auth/login` as described in the deployment guide. Then launch
Pi with:

```bash
export COGNEE_SERVICE_URL="https://cognee.example.com"
export COGNEE_API_KEY="your-bearer-token"
export COGNEE_AUTH_SCHEME="bearer"
unset COGNEE_TENANT_ID
```

For production, keep Cognee on a private network or behind a reviewed HTTPS
boundary. Self-hosted storage does not necessarily mean local inference: records
leave the host when Cognee uses an external LLM or embedding provider.

## Local data

The exact event timeline and pending delivery payloads are stored by default at:

```text
$XDG_DATA_HOME/workgraph/workgraph.db
```

When `XDG_DATA_HOME` is unset, the default is
`~/.local/share/workgraph/workgraph.db`. For a server or container, point
`WORKGRAPH_DATA_DIR` at a persistent writable volume, for example:

```bash
export WORKGRAPH_DATA_DIR="/srv/data/workgraph"
```

Do not use an ephemeral checkout or temporary directory if pending writes must
survive restarts.

### Upgrading an earlier pre-release checkout

Earlier Workgraph commits used `brwsr-initiative-...` datasets and a `brwsr.db`
file. This release deliberately replaces those internal names. There is no
automatic migration: stop all Workgraph processes and either begin with fresh
evaluation data or migrate the SQLite file and already delivered Cognee datasets
before relying on the new names.

## Pi tools

| Tool | Purpose |
| --- | --- |
| `initiative_memory_status` | Show scope, backend, and pending writes |
| `initiative_memory_recall` | Search only the locked initiative dataset |
| `initiative_memory_remember` | Append one bounded, sourced memory record |
| `initiative_timeline` | Read the exact ordered SQLite event timeline |

`initiative_memory_remember` accepts an optional stable `entity_id`. Supply one
when later records should refer to the same decision, blocker, or artifact;
otherwise Workgraph creates a unique ID. None of the tools accepts a dataset
argument.

## Runtime configuration reference

| Variable | Required | Meaning |
| --- | --- | --- |
| `COGNEE_SERVICE_URL` | For Cognee | API base URL without `/api/v1` |
| `COGNEE_AUTH_SCHEME` | No | `x-api-key` (default), `bearer`, or `none` |
| `COGNEE_API_KEY` | Except `none` | Cloud API key or self-hosted bearer token |
| `COGNEE_TENANT_ID` | Cognee Cloud | Tenant ID sent as `X-Tenant-Id` |
| `WORKGRAPH_COGNEE_TIMEOUT_MS` | No | HTTP timeout; default `3000` |
| `WORKGRAPH_DATA_DIR` | No | Persistent SQLite directory |
| `WORKGRAPH_DATASET_PREFIX` | No | Dataset prefix; default `workgraph-initiative` |
| `MULTICA_WORKSPACE_ID` | Managed run | Workspace used for every Multica read |
| `MULTICA_TASK_ID` | Managed run | Exact assigned agent task and fallback run identity |
| `MULTICA_RUN_ID` | No | Optional distinct run identity; takes precedence over the task UUID |
| `MULTICA_AGENT_ID` | Managed run | Agent used for task lookup |
| `MULTICA_ISSUE_ID` | Alternative | Explicit issue when no task is supplied |
| `MULTICA_BIN` | No | Multica executable; default `multica` |

Credentials are read only from the process environment.

## Authority and failure behavior

| Information | Authority | Workgraph behavior |
| --- | --- | --- |
| Issues, tasks, assignments, runs | Multica | Re-read; current state wins |
| PR, checks, delivery state | GitHub/repository | Agent verifies directly |
| Event order and delivery | Workgraph SQLite | Use the timeline tool |
| Semantic context | Cognee | Non-authoritative recall lead |

Cognee failure never blocks Pi. A failed write remains pending in SQLite and is
retried during later writes or shutdown. If Multica becomes unavailable for an
operation, Workgraph omits memory for that operation. If Multica reports a
different root after scope was locked, the operation fails closed and the
process never switches datasets.

SQLite event payloads are append-only. Delivery attempt counters, delivery
timestamps, and bounded errors are mutable metadata on those events. Workgraph
sends a payload hash in the `Idempotency-Key` header, but Cognee does not
currently document server-side support for that header. Delivery is therefore
at least once after an ambiguous timeout and duplicate extraction is possible.

## Security and privacy

Permanent records should contain only bounded information needed by future runs
and a source that lets an agent verify it. Do not store credentials, personal
data, raw transcripts, shell logs, complete files, full diffs, or unrestricted
tool output.

These content rules are an operating policy, **not automatic secret or PII
redaction**. Workgraph validates record types and size but cannot determine
whether a summary contains sensitive material. Operators and agents remain
responsible for what they submit to `initiative_memory_remember`.

Workgraph exposes no delete, forget, arbitrary-dataset, global-search, raw-query,
or graph-administration operation.

## Ontology and lifecycle

The backend-neutral record vocabulary is documented in
[`docs/initiative-memory-ontology.md`](docs/initiative-memory-ontology.md) and
validated by [`src/schema.ts`](src/schema.ts). Cognee applies its default graph
extraction; Workgraph does not install a custom graph model.

| Pi event | Workgraph behavior |
| --- | --- |
| `session_start` | Resolve and lock one verified initiative |
| `before_agent_start` | Refresh, recall, and inject separated context |
| `agent_settled` | Record the run/issue state and schedule delivery |
| `session_before_compact` | Record a run/status anchor |
| `session_shutdown` | Flush pending delivery and close SQLite |

General `tool_execution_end` capture is deliberately absent.

## Multica hierarchy assumptions

Workgraph treats `parent_issue_id` as canonical and never reconstructs hierarchy
from project, repository, branch, working directory, title, prompt text,
similarity, or a previously selected dataset. Parent traversal has a maximum
depth of 32 and rejects cycles.

Cross-project traversal is verified against Multica `v0.4.35`, whose
[`IssueService`](https://github.com/multica-ai/multica/blob/v0.4.35/server/internal/service/issue.go)
validates project and parent independently within one workspace. The behavior is
also covered by Multica's
[`TestCreateSubIssueUsesExplicitProjectOverParentProject`](https://github.com/multica-ai/multica/blob/v0.4.35/server/internal/handler/handler_test.go).

## Development

```bash
npm ci
npm run check
```

The tests cover dataset derivation, exact task and parent-chain resolution,
cross-project traversal, scope immutability, `No initiative`, outbox ordering and
idempotency, Cognee endpoint routing and authentication, and outage-safe
delivery.

## Provenance and license

Workgraph is a fork of
[`@kerryhatcher/pi-cognee`](https://github.com/kerryhatcher/pi-cognee). It
retains the upstream MIT license while replacing the generic SDK/MCP and
destructive tool surface with the initiative-scoped architecture above.
