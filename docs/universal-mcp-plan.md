# Universal Workgraph MCP plan

## Decision summary

Workgraph remains the product, repository, package, and owner of the Multica to
Cognee memory contract. It is not renamed or moved into a `multica-cognee`
repository. The next architecture makes a new `workgraph-mcp` executable the
canonical integration surface for every MCP-capable agent harness.

There is one implementation of initiative resolution, authority, capture,
retrieval, ontology, Cognee transport, and durable delivery. Pi, Claude Code,
and future harnesses consume that implementation through MCP. They do not each
reimplement Workgraph behavior.

The target memory layout is one Cognee dataset per Multica workspace or other
shared permission and retention domain, with overlapping NodeSets for the
active initiative, record type, authority, repository, and delivery stage. The
root Multica issue UUID remains the canonical identity stored in every record;
its stable human-readable identifier, such as `B-184`, is the NodeSet label.

This document is an implementation plan. It does not authorize a production
dataset migration, Cognee Cloud mutation, secret change, server deployment, or
removal of the current Pi extension.

## Why MCP is the integration boundary

Pi already obtains MCP support through `pi-mcp-adapter`, while Claude Code can
connect to MCP servers natively. Claude Code plugins can package skills, hooks,
and MCP configuration, but a custom plugin is not required merely to connect
to Workgraph:

- <https://code.claude.com/docs/en/mcp>
- <https://code.claude.com/docs/en/plugins>

Cognee also publishes an MCP server. Its generic surface is intentionally not
the Workgraph boundary because it accepts caller-selected datasets and includes
broad memory-management operations. It does not enforce a verified Multica
root, Workgraph authority, bounded capture, or the local outbox:

- <https://docs.cognee.ai/cognee-mcp/mcp-overview>
- <https://docs.cognee.ai/cognee-mcp/mcp-tools>

Workgraph therefore owns a narrow MCP server which calls the Cognee HTTP API.
It may reuse upstream protocol patterns, but it must not proxy the unrestricted
Cognee MCP tool surface.

## Target architecture

```text
Multica-managed or interactive agent process
  |
  +-- Pi + existing pi-mcp-adapter
  +-- Claude Code native MCP configuration
  +-- another MCP-capable harness
        |
        v
  workgraph-mcp (one process per agent session/run)
        |
        +-- Multica resolver and fresh authority reads
        +-- immutable workspace and initiative scope
        +-- bounded record and engineering-work vocabulary
        +-- SQLite outbox and exact timeline
        +-- Cognee HTTP client
        |
        v
  one Cognee dataset per Multica workspace
        |
        +-- initiative:B-184
        +-- type:decision
        +-- authority:confirmed
        +-- repo:devbox
        +-- stage:implementation
```

The MCP entrypoint is thin protocol code over the existing Workgraph modules.
Business behavior remains in testable core classes rather than MCP handlers.
The package should ultimately have these public entrypoints:

```text
@br-ws-r/workgraph       core types and runtime
@br-ws-r/workgraph/mcp   MCP server factory
workgraph-mcp             stdio executable
@br-ws-r/workgraph/pi    temporary compatibility adapter
```

The server uses stdio by default. No network listener, Caddy route, or firewall
change is needed. A remote MCP transport is a separate security design and is
not part of this plan.

## Harness integration

### Pi

Configure the existing `pi-mcp-adapter` to start `workgraph-mcp`. Do not add new
business logic to the Pi extension. Keep the existing extension during the
migration so current lifecycle behavior remains available until MCP parity is
proven. Remove it only after the MCP path passes managed and interactive Pi
acceptance tests and Workbook no longer depends on Pi-specific tool names.

### Claude Code

Use Claude Code's native MCP configuration to start the same executable. A
custom Claude Code plugin is not required for the first release. A later plugin
may package `.mcp.json`, a Workgraph skill, and lifecycle hooks for easier
installation, but it must contain no memory, scope, or delivery logic.

The upstream Cognee Claude Code plugin is not used. It captures prompts, tool
traces, and assistant responses into Cognee sessions, which conflicts with the
Workgraph rule against raw transcript and unrestricted tool-trace capture. It
also bypasses Multica scope and the Workgraph outbox.

### Other harnesses

Any client that supports local stdio MCP receives the same tools and behavior.
Non-MCP clients may use a future CLI facade over the same core, but a second
memory implementation is out of scope.

### Lifecycle limitation

MCP exposes capabilities but does not guarantee that a harness calls a tool at
the start and end of every turn. The first portable release handles this with:

1. MCP server instructions describing the required call order;
2. Workbook instructions that require `workgraph_context` before substantive
   work and `workgraph_settle` before completion;
3. Multica-managed environment variables that let the server resolve scope
   without trusting model-provided identifiers; and
4. acceptance tests in Pi and Claude Code.

Harness-specific hooks remain an optional packaging improvement. If testing
shows that instruction-driven lifecycle calls are unreliable, add thin hooks
that invoke MCP tools; do not duplicate the underlying behavior.

## Scope and identity

### Dataset boundary

Use a dataset for a shared permission and retention domain, normally one
Multica workspace:

```text
workgraph-workspace-<workspace-uuid>
```

Cognee defines datasets as the boundary for storage, permissions, and pipeline
execution, while NodeSets are semantic subsets inside a dataset:

<https://docs.cognee.ai/core-concepts/further-concepts/datasets>

Separate datasets remain required when two workspaces or customers have
different access, privacy, retention, or deletion policies. NodeSets must never
be treated as an authorization boundary.

### Initiative NodeSet

Every permanent record receives exactly one initiative NodeSet derived from
the verified root issue:

```text
initiative:B-184
```

Use the root issue's stable Multica `identifier`, not its mutable title. Store
the exact UUID separately in `initiative_id`; also store `initiative_identifier`
for display and provenance. If Multica does not return an identifier, use the
UUID as the fallback NodeSet value. A caller cannot provide or override either
value.

The UUID remains canonical because it is immutable and globally unambiguous.
The readable identifier is safe as a NodeSet within a workspace dataset, where
Multica guarantees its practical uniqueness.

### Additional NodeSets

Workgraph derives a bounded, namespaced set of labels from validated fields:

- `type:decision`, `type:blocker`, `type:evidence`, `type:handoff`,
  `type:artifact`, `type:run`, and the engineering types below;
- `authority:confirmed`, `authority:observed`, `authority:proposed`, or
  `authority:inferred`;
- `repo:<stable-repository-slug>` when the source identifies a repository; and
- `stage:<stable-stage-slug>` when Multica supplies a stage.

Namespacing keeps Cognee's flat NodeSet namespace unambiguous. Agents cannot
invent arbitrary NodeSets. Titles, free-form labels, branch names, and user
input are not converted automatically into NodeSets.

NodeSets become graph nodes connected by `belongs_to_set` and can constrain
recall through `node_name` filters:

<https://docs.cognee.ai/core-concepts/further-concepts/node-sets>

## Recall policy

Workgraph must support both current-initiative focus and deliberate historical
connection inside the workspace dataset.

`workgraph_context` performs two bounded lanes:

1. current initiative context filtered by `initiative:<identifier>`; and
2. a smaller workspace-wide related-history search that may find previous
   initiatives through shared entities such as a repository, component,
   failure, decision, or technique.

Results must be separated and label every historical item with its initiative
identifier, observed time, source, and authority. Historical context is never
presented as current Multica or GitHub state.

`workgraph_recall` accepts a constrained scope enum:

- `initiative` for only the active initiative;
- `workspace` for cross-initiative history; or
- `both` for separated results.

It accepts no dataset name, arbitrary graph query, or unrestricted NodeSet
expression. The active workspace dataset and initiative filter are resolved by
the server.

Replace the fixed legacy `GRAPH_COMPLETION` call with the current Recall API
after compatibility is proven against the pinned Cloud and self-hosted
versions. Prefer auto-routing or bounded hybrid retrieval, `only_context` for
agent prompt injection, and source references:

<https://docs.cognee.ai/core-concepts/main-operations/recall>

## MCP tool surface

The initial server exposes only:

| Tool | Contract |
| --- | --- |
| `workgraph_status` | Show verified scope, Cognee availability, and pending delivery count |
| `workgraph_context` | Refresh Multica and return separated authoritative state, initiative memory, and related history |
| `workgraph_recall` | Query `initiative`, `workspace`, or `both` within the locked workspace dataset |
| `workgraph_remember` | Queue one bounded and sourced record with server-derived NodeSets |
| `workgraph_timeline` | Read exact local events, optionally limited to the current initiative |
| `workgraph_settle` | Refresh Multica, append a bounded run outcome, and request a time-bounded outbox flush |

The server exposes no dataset argument, global tenant search, delete, forget,
prune, raw Cypher, arbitrary file ingestion, raw transcript ingestion, or
Cognee administrative tool.

Managed runs resolve scope from `MULTICA_WORKSPACE_ID`, `MULTICA_TASK_ID`, and
`MULTICA_AGENT_ID`, with `MULTICA_RUN_ID` when present. Interactive processes
use a verified `MULTICA_ISSUE_ID`. No verified initiative means fail-closed
memory tools while the host agent remains usable.

## Durable data and delivery

Keep SQLite as the exact local event log and at-least-once delivery outbox. The
MCP process uses the existing WAL and busy-timeout behavior so concurrent agent
sessions can share the database safely.

Each event stores at least:

- workspace UUID;
- root initiative UUID and readable identifier;
- current issue, task, agent, and run identifiers where known;
- record type and authority;
- source and source revision;
- derived NodeSets;
- bounded summary and relations;
- observed time, payload hash, delivery attempts, bounded last error, and
  delivery time.

Cognee remains the non-deterministic semantic projection. Reingestion uses
SQLite records rather than exporting Cognee's graph.

## Vocabulary and ontology

### Workflow vocabulary

Retain and refine:

- `Initiative`, `Issue`, `Task`, `Agent`, `Squad`, `Handoff`, `Decision`,
  `Blocker`, `Artifact`, `Repository`, `Run`, `Evidence`, and `Conflict`.

### Engineering-work extension

Add work-level concepts without modeling the source tree:

- `Artifact`: `Commit`, `PullRequest`, `TestResult`, `Deployment`;
- `Change`: `Fix`, `Refactor`, `Feature`;
- `Problem`: `Bug`, `Error`, `Failure`; and
- `CodeComponent`: `Repository`, `Service`, `Component`.

Add bounded relations such as `implements`, `fixes`, `introduced_by`,
`verified_by`, `changes`, `caused_by`, `reviewed_in`, `deployed_as`, and
`related_to` while retaining existing workflow relations.

Workgraph stores the meaning and provenance of work: why a change happened,
what it fixed, what verified it, and which decision or initiative it supports.
Git and language tooling remain authoritative for files, symbols, diffs, and
the current codebase. Function-, class-, AST-, and log-line graphs are out of
scope.

### Guided extraction first

Pass a versioned custom extraction prompt through Cognee `remember` so Cognee
preserves Workgraph types, relation labels, and stable identifiers instead of
inventing near-duplicates. The prompt and its tests live in this repository.

### Cognee ontology second

After the guided extraction comparison, add a small versioned RDF/OWL ontology
covering the workflow and engineering-work concepts. Start with Cognee's
non-destructive annotation behavior rather than strict filtering. Keep the
schema, extraction prompt, and ontology under consistency tests:

<https://docs.cognee.ai/core-concepts/further-concepts/ontologies>

The current `docs/initiative-memory-ontology.md` is a Workgraph vocabulary, not
an ontology already loaded into Cognee. Rename or clarify it during delivery so
the two layers cannot be confused.

## Capture policy

Automatically capture only meaningful bounded events:

- verified initiative and issue transitions;
- accepted decisions and their rationale;
- blockers and their resolution;
- handoffs between agents or stages;
- commits, pull requests, test results, and deployments when an authoritative
  source is available;
- fixes, refactors, failures, and verification evidence; and
- final bounded run outcomes and compaction anchors.

Do not capture full prompts, assistant transcripts, unrestricted tool traces,
shell logs, complete diffs, repository contents, or every compiler message.
Current Multica, GitHub, and repository reads always outrank remembered state.

## Repository ownership

### `br-ws-r/workgraph`

Owns all executable behavior, MCP schema, vocabulary, extraction prompt,
ontology, outbox migrations, tests, and protocol documentation.

### `br-ws-r/workbook`

Owns harness-neutral operating instructions: required context/settle calls,
when a fact deserves permanent memory, authority rules, and how to verify
historical recall. It contains no Cognee transport or SQLite implementation.

### `br-ws-r/devbox`

Pins the reviewed Workgraph revision, installs the executable, projects
root-owned credentials, configures the existing Pi MCP adapter and other local
clients, verifies runtime registration, and performs the deployment/report
workflow. It does not fork Workgraph logic.

### Cognee Cloud or self-hosted Cognee

Stores and processes the semantic projection. Cloud-side ontology upload,
provider selection, reindexing, dataset creation, and data migration are
external-state operations with their own approval and evidence.

## Migration from initiative datasets

The existing `workgraph-initiative-<uuid>` datasets remain untouched until the
new layout is accepted.

1. Add workspace and readable initiative identity to new SQLite events without
   rewriting historical payloads silently.
2. Create a new `workgraph-workspace-<workspace-uuid>` dataset in an isolated
   or approved Cloud test scope.
3. Replay bounded timeline records into it with derived NodeSets, the extraction
   prompt, and stable canonical IDs.
4. Verify current-initiative isolation, cross-initiative discovery, provenance,
   duplicate behavior, and outage retry.
5. Switch Workgraph to the workspace dataset only through a reviewed release
   and deployment.
6. Retain old datasets for the documented rollback window. Deletion is a
   separate explicit retention decision.

Because Cognee graph extraction can change across versions and models,
acceptance compares behavior and provenance rather than graph byte equality.

## Delivery stages

### Stage 0 — Plan acceptance

- Merge this plan only after its dataset, MCP, lifecycle, and ontology decisions
  are accepted.
- Make no runtime, Cloud, credential, or deployment change.

### Stage 1 — Workgraph MCP foundation

- Separate any remaining Pi assumptions from the core runtime.
- Add a pinned MCP SDK and stdio `workgraph-mcp` executable.
- Implement the narrow tools, immutable environment-derived scope, server
  instructions, graceful flush, and protocol tests.
- Preserve the existing Pi extension as a compatibility path.
- Acceptance: unit tests, MCP initialize/tools-list/tool-call smoke tests,
  fail-closed no-initiative behavior, and no destructive tools.

### Stage 2 — Workspace dataset and NodeSets

- Extend Multica parsing with `workspace_id`, root `identifier`, and stable
  stage/repository metadata where available.
- Derive the workspace dataset and bounded NodeSets server-side.
- Extend the SQLite schema through an idempotent migration.
- Implement initiative/workspace/both recall scopes and provenance-labelled
  two-lane context.
- Add the versioned extraction prompt and Recall API compatibility layer.
- Acceptance: two initiatives share useful entities, initiative-only recall
  does not leak unrelated records, and workspace recall identifies the source
  initiative of every result.

### Stage 3 — Workflow and engineering ontology

- Extend the TypeScript schema and documentation.
- Add extraction fixtures for decisions, commits, pull requests, failures,
  fixes, refactors, tests, and deployments.
- Compare default and guided extraction for duplicate types and relations.
- Add the focused RDF/OWL ontology in annotation mode only after prompt results
  are acceptable.
- Acceptance: canonical IDs and relation labels remain stable and unmatched
  useful concepts are not discarded.

### Stage 4 — Harness rollout

- Update Workbook with harness-neutral MCP operating instructions.
- Update Devbox to install the reviewed executable and configure the existing
  Pi MCP adapter.
- Add a Claude Code native-MCP smoke path without a custom plugin.
- Prove interactive and Multica-managed Pi plus Claude Code against the same
  Workgraph core and workspace dataset.
- Remove the Pi extension only in a later reviewed release after feature and
  lifecycle parity is recorded.

### Stage 5 — Data migration and production adoption

- Requires explicit approval for the Cognee Cloud or self-hosted external-state
  mutation and the exact migration target.
- Reingest from the outbox into the workspace dataset, validate behavioral
  acceptance, deploy the exact reviewed revisions, and retain rollback data.
- Complete the owning repositories' deployment evidence and report gates.

### Stage 6 — Optional enrichment

- Consider Global Context Index after workspace datasets have enough durable
  records to justify it.
- Consider a zero-logic Claude Code plugin only for distribution and lifecycle
  hooks if native MCP plus Workbook instructions are operationally weak.
- Consider embedding-provider changes separately; they require reindexing and
  are not part of the MCP migration.

## Acceptance criteria

- [ ] One Workgraph implementation serves Pi, Claude Code, and a generic MCP
  client without duplicated memory logic.
- [ ] Existing MCP support connects Pi and Claude Code; no custom Claude plugin
  is required for the initial release.
- [ ] A verified Multica workspace selects exactly one dataset and a verified
  root issue selects exactly one readable initiative NodeSet.
- [ ] UUIDs remain canonical record attributes even when readable identifiers
  are used for NodeSet labels.
- [ ] Current-initiative context and related historical initiatives are clearly
  separated and provenance-labelled.
- [ ] Workflow and engineering-work concepts are extracted consistently without
  building a source-code graph.
- [ ] No caller can choose an arbitrary dataset, NodeSet, tenant-wide query, or
  destructive Cognee operation.
- [ ] Cognee outage does not block the harness and pending writes survive MCP
  process restart.
- [ ] No raw transcript, unrestricted tool trace, secret, or full diff is
  retained.
- [ ] Old initiative datasets remain recoverable until a separately approved
  retention action.

## Explicit non-goals

- Renaming or merging the Workgraph repository into Workbook.
- Direct use of the unrestricted Cognee MCP server by agents.
- A custom Claude Code plugin with duplicated Workgraph logic.
- A public or remote Workgraph MCP listener.
- Modeling files, functions, classes, ASTs, or complete repository contents.
- Treating NodeSets as permissions.
- Allowing semantic memory to override Multica, GitHub, Git, or the exact SQLite
  timeline.
- Production migration, provider change, reindex, or data deletion in this
  planning change.

## Rollback principles

Each delivery stage must be independently reversible. Until MCP and workspace
dataset acceptance passes, the current Pi extension and initiative datasets
remain available. A rollback selects the previously reviewed Workgraph release
and dataset contract; it never repairs Cognee or SQLite ad hoc. Dataset deletion
and historical outbox rewriting are not rollback mechanisms.
