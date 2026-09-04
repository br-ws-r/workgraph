# Workspace-scoped Workgraph memory plan

## Decision summary

Workgraph remains the product, repository, package, and Pi extension that owns
the Multica-to-Cognee memory contract. It remains a focused fork of
`pi-cognee`; this plan does not introduce an MCP server, another harness, a new
repository, or a second integration path.

The principal change is the Cognee memory layout. Workgraph will use one
dataset for each verified Multica workspace and overlapping NodeSets to keep
initiative memory focused while permitting deliberate recall of related work:

```text
workgraph-workspace-<workspace-uuid>
  +-- initiative:B-184
  +-- type:decision
  +-- authority:confirmed
  +-- project:<verified-project>
  +-- stage:<verified-stage>
  +-- repo:<verified-repository>
```

The root issue UUID remains the canonical `initiative_id`. The stable Multica
identifier is stored separately and used for the readable initiative NodeSet.
The ontology remains a small, generic vocabulary for software, operations,
research, planning, hiring, procurement, and other kinds of work.

This document is an implementation plan. It does not authorize Cognee Cloud
mutation, credential changes, deployment, reindexing, or deletion.

## Target architecture

```text
Multica-managed or interactive Pi process
  |
  v
Workgraph Pi extension
  |
  +-- Multica task, issue, and root-initiative resolution
  +-- automatic Pi lifecycle context and bounded capture
  +-- generic work-memory vocabulary
  +-- SQLite exact timeline and durable delivery outbox
  +-- Cognee HTTP client
  |
  v
one Cognee dataset per verified Multica workspace
  |
  +-- current initiative memory through an initiative NodeSet
  +-- bounded related history across initiative NodeSets
```

Pi lifecycle hooks remain essential behavior:

| Pi event | Workgraph behavior |
| --- | --- |
| `session_start` | Resolve and lock the workspace and root initiative |
| `before_agent_start` | Refresh Multica and inject two-lane Cognee context |
| `agent_settled` | Record a bounded run outcome |
| `session_before_compact` | Record a compaction anchor |
| `session_shutdown` | Complete one serialized flush and close SQLite |

Agents do not have to call context or settle tools to activate this lifecycle.
The existing `use-workgraph` skill remains responsible for capture judgment,
authority rules, and safe use of recalled information.

## Scope and identity

### Workspace scope

Every memory-enabled process requires a valid `MULTICA_WORKSPACE_ID`. All
Multica reads used to establish or refresh scope must use that workspace. The
workspace UUID selects exactly one dataset:

```text
workgraph-workspace-<workspace-uuid>
```

Dataset names, IDs, and NodeSets are derived by Workgraph. A tool caller cannot
provide or override them. A process without a verified workspace remains usable
as Pi but enters fail-closed `No initiative` mode for recall, timeline, and
writes.

### Managed resolution

When `MULTICA_TASK_ID` and `MULTICA_AGENT_ID` are present, they are the
authoritative managed-run inputs. Workgraph resolves the exact agent task, its
current issue, and the persisted `parent_issue_id` chain to the root issue.

If `MULTICA_ISSUE_ID` is also present, it must match the issue resolved from the
task; it cannot replace task provenance. `MULTICA_RUN_ID` remains the preferred
run identity, with the exact task UUID as its fallback on current Multica
releases.

### Interactive resolution

Interactive Pi may select a root issue through `--initiative` or the existing
UI picker. The selection must identify a root issue in the verified workspace;
a child issue remains invalid for explicit interactive selection.

### Immutable process scope

Workgraph locks these values for the Pi process lifetime:

- workspace UUID and dataset;
- current issue UUID at selection time;
- root initiative UUID and stable identifier;
- task, run, and agent identifiers where available.

Before context injection and automatic permanent capture, Workgraph re-reads
the issue from Multica. A changed root or workspace fails closed and never
switches the dataset in-process.

## NodeSets

Each permanent record receives these server-derived NodeSets:

- exactly one `initiative:<root-identifier>`;
- exactly one `type:<record-type>`; and
- exactly one `authority:<authority>`.

Workgraph may additionally derive these labels from verified structured data:

- `project:<stable-project-identifier>`;
- `stage:<stable-stage>`; and
- `repo:<stable-repository-identifier>`.

Optional NodeSets are omitted when authoritative metadata is unavailable.
Titles, prompts, branch names, arbitrary labels, free-form sources, and other
user input are not converted into NodeSets. NodeSet values are normalized with
a documented bounded algorithm, and callers cannot submit arbitrary labels.

The root UUID remains in `initiative_id`; the exact readable identifier is also
stored as `initiative_identifier`. A missing root identifier disables memory
for the process rather than falling back to a different identity scheme.

Datasets remain the permission and retention boundary. NodeSets are semantic
subsets and must never be treated as authorization boundaries.

References:

- <https://docs.cognee.ai/core-concepts/further-concepts/datasets>
- <https://docs.cognee.ai/core-concepts/further-concepts/node-sets>

## Recall policy

### Automatic two-lane context

`before_agent_start` performs two bounded Cognee reads after a successful fresh
Multica read-back:

1. a larger current-initiative lane filtered by the active initiative NodeSet;
2. a smaller workspace-wide related-history lane over the same dataset.

The injected prompt separates:

1. authoritative current Multica state;
2. non-authoritative current-initiative memory; and
3. non-authoritative related workspace history.

Historical results must identify their initiative, authority, source, and
observation time. They are leads for verification, never current Multica,
repository, or delivery state. If Multica refresh fails, Workgraph omits both
memory lanes for that turn. If Cognee fails, Pi continues with fresh Multica
context when available.

### Explicit recall

`initiative_memory_recall` gains a constrained scope:

- `initiative` for the active initiative only;
- `workspace` for related history in the locked workspace; or
- `both` for separately labelled results.

It accepts no dataset, arbitrary NodeSet expression, raw graph query, or tenant-
wide search. Initiative remains the default.

### Cognee API compatibility

Replace the fixed legacy `GRAPH_COMPLETION` request only after the current
Recall API is verified against the supported Cognee Cloud and self-hosted
versions. Prefer bounded retrieval with `only_context` and source references
over an additional synthesized answer for Pi prompt injection.

The compatibility layer must normalize results sufficiently for Workgraph to
preserve initiative, source, authority, and observed-time labels. Completion
output without usable provenance is not sufficient for cross-initiative
injection.

Reference:

- <https://docs.cognee.ai/core-concepts/main-operations/recall>

## Generic work ontology

The Workgraph schema and extraction guidance use broad work concepts rather
than a software-only source-code model.

### Entity types

- `Initiative`, `Issue`, and `Task` describe planned work;
- `Agent` and `Squad` describe actors;
- `Decision`, `Constraint`, `Risk`, `Blocker`, and `Conflict` describe choices
  and impediments;
- `Handoff` describes transfer of responsibility or context;
- `Artifact` describes a produced object, including code, documents, reports,
  designs, campaigns, contracts, and deployments;
- `Evidence` describes tests, measurements, reviews, research, and approvals;
- `Run` describes one managed or interactive execution; and
- `Outcome` describes a bounded result.

### Relation types

Use a bounded generic relation set including `root_of`, `child_of`, `part_of`,
`assigned_to`, `owned_by`, `delegated_to`, `blocked_by`, `depends_on`,
`produced`, `supports`, `contradicts`, `derived_from`, `about`, `verified_by`,
`resulted_in`, `observed_in`, and `related_to`.

Domain-specific detail belongs in stable entity IDs, bounded summaries,
sources, and relations. Workgraph does not model files, functions, classes,
ASTs, transcript turns, or log lines.

### Guided extraction first

Pass a versioned generic `custom_prompt` and server-derived NodeSets through
Cognee Remember so extraction preserves canonical concepts, relation labels,
stable IDs, and provenance. Keep the prompt and representative fixtures in
this repository.

Fixtures must include materially different work domains, such as a software
release, incident response, marketing campaign, hiring process, and procurement
decision. Compare default and guided extraction for duplicate concepts,
relation drift, provenance, and useful unmatched information.

Add a small RDF/OWL ontology in non-destructive annotation mode only if the
guided extraction comparison demonstrates a need and measurable benefit. The
current vocabulary document must not imply that an ontology is already loaded
into Cognee.

## Capture policy

Pi lifecycle automatically records only:

- verified initiative selection and run start in the exact local timeline;
- a bounded final run outcome after a successful Multica refresh;
- a bounded compaction anchor; and
- delivery success or failure metadata.

Agents may explicitly record bounded, sourced decisions, constraints, risks,
blockers, handoffs, artifacts, evidence, conflicts, and outcomes through
`initiative_memory_remember`.

Do not capture raw prompts, assistant transcripts, unrestricted tool traces,
shell logs, complete files, full diffs, repository contents, credentials,
personal data, or every transient error. Multica, GitHub, repositories, and
other systems of record always outrank remembered state.

## Durable data and delivery

SQLite remains the exact append-only event timeline and at-least-once delivery
outbox. Cognee remains a non-deterministic semantic projection.

The workspace layout is a clean pre-1.0 cutover. New code uses a new default
SQLite file, `workgraph-workspace.db`, and does not read, rewrite, or replay the
old `workgraph.db`. Existing initiative datasets remain untouched and are not
queried by the new release. There is no automatic Cognee or SQLite migration.

Each new event stores at least:

- workspace UUID;
- current issue UUID;
- root initiative UUID and readable identifier;
- project, task, agent, and run identifiers where known;
- record type and authority;
- source and source revision;
- derived NodeSets;
- bounded summary and relations;
- schema and extraction-prompt versions;
- observed time and payload hash; and
- delivery attempts, bounded last error, lease, and delivery time.

Pending delivery is selected by workspace, not by a global batch later filtered
in memory. Concurrent Pi processes atomically claim bounded batches with an
expiring lease. A timeout after Cognee accepted a request can still produce an
at-least-once duplicate because Cognee does not document support for Workgraph's
idempotency key.

Shutdown waits for the existing serialized writer, performs at most one final
bounded flush, and never closes SQLite while another flush can still run.

## Tool surface

Retain the existing narrow Pi tools:

| Tool | Contract |
| --- | --- |
| `initiative_memory_status` | Show immutable workspace and initiative scope, Cognee availability, and workspace pending delivery |
| `initiative_memory_recall` | Recall `initiative`, `workspace`, or separated `both` within the locked workspace dataset |
| `initiative_memory_remember` | Queue one bounded sourced record with server-derived scope and NodeSets |
| `initiative_timeline` | Read the exact local timeline for the active initiative |

Workgraph exposes no caller-selected dataset, arbitrary NodeSet, delete, forget,
prune, raw Cypher, arbitrary file ingestion, or Cognee administration tool.

## Repository ownership

### `br-ws-r/workgraph`

Owns the Pi extension, generic vocabulary, extraction guidance, Multica scope,
Cognee transport, NodeSet derivation, SQLite outbox, timeline, tests, and public
runtime documentation.

### `br-ws-r/workbook`

Owns the `use-workgraph` operating instructions: what deserves permanent
memory, authority rules, verification expectations, and sensitive-data policy.
It does not duplicate the generic ontology or runtime implementation.

### `br-ws-r/devbox`

Pins the reviewed Workgraph revision, projects root-owned Cognee credentials,
preserves the durable data directory, verifies Pi extension registration, and
performs the deployment evidence and rollback workflow.

### Cognee Cloud or self-hosted Cognee

Stores and processes the semantic projection. Dataset creation, provider
selection, reindexing, and deletion are external-state actions with separate
approval and evidence.

## Delivery stages

### Stage 0: plan acceptance

- Accept the Pi-only architecture, workspace dataset, initiative NodeSets,
  two-lane recall, generic ontology, and clean cutover.
- Make no runtime, Cognee, credential, or deployment change in the planning PR.

### Stage 1: scope and storage contract

- Require and validate the Multica workspace.
- Parse and lock the root identifier and current issue provenance.
- Derive the workspace dataset and bounded NodeSets server-side.
- Introduce the new SQLite file and event schema.
- Add workspace-scoped atomic delivery claims and serialized shutdown.

Acceptance: two initiatives in one workspace share a dataset but have distinct
initiative NodeSets; two workspaces never share a dataset; invalid scope fails
closed; concurrent outbox tests pass.

### Stage 2: Cognee concepts

- Send NodeSets and the versioned extraction prompt through Remember.
- Add a tested Recall API compatibility layer.
- Implement initiative and workspace recall primitives with normalized
  provenance.
- Test synchronous ingestion completion, outage retry, and pipeline errors.

Acceptance: initiative recall does not leak unrelated work; workspace recall
finds a related record from another initiative and identifies its provenance.

### Stage 3: Pi lifecycle and tools

- Inject two separated recall lanes in `before_agent_start`.
- Fail closed on unavailable or changed Multica authority.
- Extend the recall tool with the constrained scope enum.
- Move settle and compaction capture to the new record contract.
- Add Pi extension lifecycle tests.

Acceptance: managed and interactive Pi automatically receive scoped context and
produce bounded outcomes without model-driven context or settle calls.

### Stage 4: ontology evaluation

- Extend the TypeScript schema and vocabulary documentation.
- Add fixtures from multiple technical and non-technical work domains.
- Compare default and guided extraction.
- Add RDF/OWL annotation only after demonstrated benefit.

Acceptance: canonical concepts and relations remain stable across the fixture
set without suppressing useful domain-specific information.

### Stage 5: reviewed rollout

- Update Workbook instructions for the final tool and authority contract.
- Update Devbox to pin and verify the reviewed Workgraph revision.
- Create the new workspace dataset only through an approved runtime write.
- Verify managed and interactive Pi, retry behavior, and exact timeline.
- Record the exact deployed revisions and rollback procedure.

There is no data replay. Rollback selects the previous Workgraph release, old
SQLite file, and old initiative-dataset contract; it never rewrites either
layout ad hoc.

## Acceptance criteria

- [ ] Workgraph remains one Pi extension in `br-ws-r/workgraph`.
- [ ] One verified Multica workspace selects exactly one Cognee dataset.
- [ ] Each verified root initiative selects exactly one readable initiative
  NodeSet while its UUID remains canonical record identity.
- [ ] Required type and authority NodeSets and optional verified metadata
  NodeSets are derived only by Workgraph.
- [ ] Current-initiative and related workspace history are bounded, separated,
  and provenance-labelled.
- [ ] Pi lifecycle performs context and settle automatically.
- [ ] The generic ontology works across technical and non-technical fixtures.
- [ ] No caller can select a dataset, arbitrary NodeSet, tenant-wide query, or
  destructive Cognee operation.
- [ ] Cognee outage does not block Pi and pending writes survive restart.
- [ ] Concurrent Pi processes do not starve another initiative's delivery.
- [ ] No raw transcript, unrestricted tool trace, credential, or full diff is
  retained.
- [ ] Old SQLite and initiative datasets are never modified or replayed.

## Explicit non-goals

- An MCP server or support for another agent harness.
- A new repository, package rename, or move into Workbook.
- Workspace-authored ontology profiles in this delivery.
- Direct use of the unrestricted Cognee MCP server.
- Caller-selected datasets or NodeSets.
- Modeling source trees, symbols, ASTs, transcripts, or complete repository
  contents.
- Treating NodeSets as permissions.
- Allowing semantic memory to override Multica, GitHub, Git, or SQLite.
- Migrating old outbox records or reingesting old initiative datasets.
- Production dataset mutation, provider changes, reindexing, or deletion in the
  planning change.
