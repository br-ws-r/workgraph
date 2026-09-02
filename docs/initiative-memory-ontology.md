# Initiative Memory Ontology

This document and `src/schema.ts` are the canonical, backend-neutral Workgraph
vocabulary. Cognee stores records and extracts a semantic graph; it is not the
authority for the vocabulary itself.

## Entity types

`Issue`, `Task`, `Agent`, `Squad`, `Handoff`, `Decision`, `Blocker`, `Artifact`,
`Repository`, `Run`, `Evidence`, and `Conflict`.

## Relation types

`root_of`, `child_of`, `assigned_to`, `owned_by`, `delegated_to`, `blocked_by`,
`depends_on`, `produced`, `for`, `supports`, `from`, `about`, `verified_by`,
`implemented_in`, and `observed_in`.

## Authority

- `confirmed`: explicitly verified evidence or decision.
- `observed`: a bounded read-back from an authoritative system.
- `proposed`: a proposal that has not become authoritative state.
- `inferred`: semantic retrieval or model-derived interpretation.

Fresh Multica and GitHub state always outranks every Workgraph record,
including a previously `confirmed` record that has become stale.

## Record envelope

Every permanent record has this validated shape:

```json
{
  "entity_type": "Decision",
  "authority": "confirmed",
  "initiative_id": "00000000-0000-4000-8000-000000000001",
  "entity_id": "decision:one-dataset-per-initiative",
  "summary": "Use one Cognee dataset per root Multica initiative.",
  "relations": [
    { "type": "about", "target": "issue:00000000-0000-4000-8000-000000000001" }
  ],
  "source": "multica://issues/00000000-0000-4000-8000-000000000001",
  "source_revision": "optional-source-revision",
  "observed_at": "2026-08-30T09:00:00Z"
}
```

Summaries are bounded to 4,000 characters. Sources, timestamps, authority, and
stable entity identifiers are mandatory. Secrets, raw transcripts, raw tool
output, shell logs, full diffs, and unrestricted file contents are forbidden.

## Timeline versus semantic graph

SQLite is the exact event audit and delivery source. Event payloads are
append-only; delivery attempts and results are mutable metadata. Cognee provides
semantic answers over the same bounded records. Chronology and delivery status
must be read from `initiative_timeline`, never reconstructed through temporal
LLM extraction. Reingestion can rebuild a useful graph, but graph extraction is
not expected to be bit-for-bit deterministic across model or Cognee versions.

The initial release uses Cognee's default extraction. A custom Cognee graph
model is permitted only after tests demonstrate inconsistent entity or relation
mapping, and its definition must live in this repository.
