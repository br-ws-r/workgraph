# Live memory relay acceptance protocol

This is an operator/PM runbook for the six existing Multica agents. It creates
no production code task and requires no new squad, scheduler, or database.
Execute it after both hosts load the reviewed Workgraph revision. It tests
remote recall, delivery, graph projection, and completion as separate facts.

## Preparation and ownership

1. Record the exact Workgraph commit, Pi/OMP versions, Multica CLI version,
   runtime IDs, and redacted `initiative_memory_status` for each participant.
   `cogneeConfigured` means configuration is present, not a health check.
2. PM owns one root issue and its six stage children. Keep only the first
   unblocked child `todo`; later stages are `backlog` with an explicit predecessor.
   Order: PM (Pi), Admin (OMP), Developer (OMP), Reviewer (OMP), Theon (Pi),
   Planner (OMP). Verify the live roster instead of assuming assignments.
3. PM must perform the applicable Planner intake/label/handoff requirements
   before releasing its step. A memory evaluation does not override agent policy.
   If a role cannot accept an evaluation under its existing instructions,
   record that gap and route an instruction change through Workbook review.
4. Every child names PM as the reviewer of its evidence. Passing evidence must
   result in a Multica `done` transition. If the agent's normal workflow ends at
   `in_review`, it must hand off to PM using the approved agent handoff mechanism;
   PM reviews and closes it. Do not wait for a stage-complete notification while
   the child is still in review. Re-read after mutations and verify the actual
   task trigger. A prose-only promise is not a continuation.
5. PM re-reads all children before every stage release and after the last stage.
   Stage notifications wake the parent owner but do not release backlog children
   or guarantee parent closure. Use current state to avoid duplicate starts.

## Each writer and reader

Use a new public evaluation ID and canonical entity IDs such as
`decision:relay-<eval>-1` through `decision:relay-<eval>-6`. Every writer generates
its own random synthetic token during its run. The reader task includes the
predecessor entity ID and a descriptive query, but never the expected token.
Do not hard-code the expected predecessor payload into the next task as B-198 did.

Read the current Multica issue before calling memory tools. Starting at hop 2,
call `initiative_memory_recall` with the predecessor `entity_identifier` and
record its actual tool output. A timeline read, previous comment, prompt-injected
memory, or copied task description cannot satisfy this step. The evaluator
compares the output to the writer's evidence separately. Never report PASS from
the model's prose alone.

Write one bounded sourced record with:

```json
{
  "entity_type": "Decision",
  "entity_identifier": "decision:relay-<eval>-2",
  "entity_label": "Memory relay hop 2",
  "authority": "confirmed",
  "summary": "Synthetic memory relay <eval>, hop 2, Admin: <generated token>",
  "source": "multica://issues/<this-child>",
  "relations": [
    {"type": "derived_from", "target": "decision:relay-<eval>-1"},
    {"type": "observed_in", "target": "issue:<this-child>"},
    {"type": "about", "target": "initiative:<root>"}
  ]
}
```

Hop 1 omits `derived_from`. Keep canonical type prefixes: using an untyped
predecessor name with `derived_from` lets the serializer infer `Evidence`, which
may conflict with a Decision written earlier. Relations are authored facts;
Workgraph must not infer the relay from text or retrofit B-198 automatically.

Save the returned event ID. Inspect `initiative_timeline` by that ID; use the
existing host wait mechanism between checks, at most five checks 30 seconds
apart. `pending` is neither success nor proof of permanent failure. If still
pending after this window, hand off the exact event ID and status to PM with a
concrete retry owner; do not create another copy of the same write. Startup and
settlement retry pending writes. After `delivered`, independently recall the
new record from Cognee and retain the actual response. Reading a delivered local
event alone is insufficient.

## Evidence and final verdict

Attach the applicable agent result through the normal Multica handoff path.
Retain the actual memory tool responses with evaluation ID, child/run/runtime,
entity ID, event ID, delivery timestamp/attempts, predecessor recall, and own
read-back. Do not include credentials or unrelated workspace memory.

PM verifies all of the following before closing the parent:

- Six distinct writers and all required hops have remote tool evidence. After
  hop 6, PM performs a fresh Pi recall of Planner's final OMP record, closing the
  loop and testing that final write from another run.
- Each relay event is delivered and each token matches the independent writer
  evidence. Automatic activity records are counted separately. There is no
  aggregate checksum requirement unless its algorithm and inputs are defined.
- Each serialized record has the expected workspace, root, source, type,
  NodeSets (including stage), and exact declared relations. Compare a read-only
  Cognee graph/export with the source projection if available; the screenshot
  alone cannot prove edge type, absence of duplicates, or complete ingestion.
- A fresh run of each host can recover a deliberately interrupted synthetic
  delivery using the existing outbox. Use a test endpoint/runtime configuration
  for this step, not a production outage or credential change.
- Every child is actually `done`; PM records the evidence verdict and closes
  the parent with a verified read-back. Otherwise report the precise failed gate
  and keep the initiative incomplete with a named next owner.

The test reports separate verdicts for remote memory, recovery, graph shape,
and workflow completion. Missing evidence is inconclusive, never PASS.

## Graph visibility and limits

Use `initiative_timeline` with `records: "explicit"` to review authored memory
without activity noise. Cognee Mindmap is an external UI, so this repository
cannot change its default lens. Where available, use type/authority/initiative
filters there. Never delete audit evidence to improve a screenshot, and never
assume all Evidence entities are automatic (Reviewer used Evidence in B-198).

`tests/host-delivery.test.ts` exercises both adapters, real SQLite, serialization,
and the HTTP client with a simulated Cognee service. It is repeatable CI coverage,
not a substitute for this live runtime acceptance test. No test is considered
live merely because data is visible in Mindmap.
