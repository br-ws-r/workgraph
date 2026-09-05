# Workspace Memory Ontology

This document and `src/schema.ts` define the backend-neutral Workgraph
vocabulary. Cognee stores a semantic projection; it is not the authority for
the vocabulary or current work state.

## Entity types

- `Initiative`, `Issue`, and `Task` describe planned work.
- `Agent` and `Squad` describe actors.
- `Decision`, `Constraint`, `Risk`, `Blocker`, and `Conflict` describe choices
  and impediments.
- `Handoff` describes a transfer of responsibility or context.
- `Artifact` describes any produced object, including a document, report,
  design, campaign, contract, deployment, or code change.
- `Evidence` describes a test, measurement, review, research result, or
  approval.
- `Run` describes one managed or interactive execution.
- `Outcome` describes a bounded result.

## Relation types

`root_of`, `child_of`, `part_of`, `assigned_to`, `owned_by`, `delegated_to`,
`blocked_by`, `depends_on`, `produced`, `supports`, `contradicts`,
`derived_from`, `about`, `verified_by`, `resulted_in`, `observed_in`, and
`related_to`.

Domain-specific detail belongs in stable entity identifiers, bounded summaries,
sources, and these relations. Workgraph does not model source trees, symbols,
transcript turns, or log lines as ontology types.

## Authority

- `confirmed`: explicitly verified evidence or a decision.
- `observed`: a bounded read-back from an authoritative system.
- `proposed`: a proposal that has not become authoritative state.
- `inferred`: semantic retrieval or model-derived interpretation.

Fresh systems of record always outrank remembered state, including a previously
confirmed record that has become stale.

## Workspace envelope

Every permanent record uses the current `schema_version` and
`extraction_prompt_version`, and includes validated workspace, root initiative,
current issue, authority, provenance, and observation time:

```json
{
  "schema_version": "3.0.0",
  "extraction_prompt_version": "2.0.0",
  "workspace_id": "00000000-0000-4000-8000-000000000010",
  "workspace_identifier": "brwsr",
  "workspace_name": "BRWSR",
  "initiative_id": "00000000-0000-4000-8000-000000000001",
  "initiative_identifier": "B-184",
  "issue_id": "00000000-0000-4000-8000-000000000002",
  "issue_identifier": "B-185",
  "entity_type": "Decision",
  "authority": "confirmed",
  "entity_identifier": "decision:workspace-memory",
  "entity_label": "Workspace memory decision",
  "summary": "Use one memory dataset per verified workspace.",
  "relations": [
    { "type": "about", "target": "issue:B-185" }
  ],
  "node_sets": [
    "initiative:B-184",
    "type:decision",
    "authority:confirmed"
  ],
  "source": "multica://issues/B-185",
  "observed_at": "2026-09-04T09:00:00Z"
}
```

Summaries are bounded to 4,000 characters. Secrets, raw transcripts, raw tool
output, shell logs, full diffs, and unrestricted file contents are forbidden.

## Scope and NodeSets

A verified workspace slug selects `workgraph-workspace-<workspace-slug>`. UUID
fields remain exact internal identity and provenance. Readable `*_identifier`
fields, semantic entity identifiers, relation targets, filenames, and NodeSets
must not contain full UUIDs.

Workgraph derives the complete ordered NodeSet list server-side. Every record
has exactly one `initiative:`, `type:`, and `authority:` NodeSet. It may also
have `project:`, `stage:`, and `repo:` NodeSets when matching verified
structured metadata is explicitly present. A repository NodeSet is never
inferred from a source URL, title, branch, prompt, or other free-form text.

NodeSet values are trimmed, Unicode-normalized with NFKD, and runs outside
ASCII letters, digits, `.`, `_`, and `-` become one `-`. Repeated punctuation
and leading or trailing punctuation are removed. Any transformed or overlong
value receives a deterministic hash suffix so distinct source identifiers do
not collapse to the same label. Values are bounded to 96 characters and empty
results are rejected. The complete label is bounded to 128 characters,
optional labels have a fixed prefix, and record validation requires the exact
deterministic order. Callers cannot append arbitrary labels.

The complete UTF-8 serialized memory record is limited to 12,000 bytes and sent
with a 16,384-character Cognee chunk size so `CHUNKS` recall can validate one
whole record rather than an arbitrary fragment.

Datasets are permission and retention boundaries. NodeSets are semantic subsets
and must not be treated as authorization boundaries.

## Extraction and timeline

The versioned extraction document presents exact node identifiers and relations
in a small `WORKGRAPH_GRAPH_V1` section. The complete validated record follows a
`WORKGRAPH_RECORD_V1` marker so Recall can recover provenance without asking the
graph extractor to reinterpret its envelope fields. The prompt remains guidance
for a non-deterministic semantic projection, not a custom graph model or a claim
that an RDF/OWL ontology is loaded.

SQLite is the exact append-only event and delivery source. Chronology and
delivery status come from the local timeline, never temporal model extraction.
Reingestion may rebuild a useful graph but is not expected to be bit-for-bit
deterministic across model or Cognee versions.
