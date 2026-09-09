# Reliable delivery context and continuation

B-226 exposed two independent failures: authored `IN PROGRESS —` and `Merged.`
comments were skipped by a period-only parser, and the delivery owner ended its
run while deployment/data acceptance remained unfinished. Memory alone cannot
wake a stopped process. This change supplies both sourced context and a durable,
opt-in continuation executor; it never treats PR merge as acceptance.

## Capture and repair

Handoffs accept case-insensitive DONE, BLOCKED, IN PROGRESS, NEEDS DECISION,
MERGED, and DECISION RESOLVED prefixes with a period, colon, dash or Markdown
bold marker. Only the first bounded paragraph of an authored agent comment with
server task provenance is captured. Attachments and transcripts stay excluded.
Credential-pattern rejection remains in place. `initiative_delivery_status`
reports capture counts, including unsupported formats and credential rejection.

Normal capture still baselines existing comments. On an affected selected issue,
call `initiative_handoffs_repair` with an explicit RFC3339 `since` timestamp.
For B-226 the incident boundary is `2026-09-09T00:00:00Z`. It reconsiders even
previously seen comments, retains original source IDs/timestamps, deduplicates
against existing events and refuses truncated history. Repair queues records;
verify delivery with `initiative_timeline` and remote readability with recall.
This is an explicit recovery operation, not an automatic historical replay.

## Current state and graph

Each fresh delivery context reads the selected issue and its complete direct
children from Multica. Malformed, foreign, duplicate or incomplete children
responses fail closed. Distinct snapshots produce Issue nodes with explicit
`child_of` and `part_of` edges, under the verified root initiative. They remain
historical facts in Cognee. The prompt also gets live child states, recent local
handoffs, capture diagnostics and continuation state independently of recall.

A child context registers a persistent notification for its parent when that
child becomes terminal. An assigned agent/squad owner is required. Parent
acceptance is always re-evaluated: a cancelled child is not successful delivery.
Registration errors remain visible in delivery context.

## Waiting for deployment

Before stopping on an external workflow, the agent calls:

```json
{
  "workflow_url": "https://github.com/br-ws-r/devbox/actions/runs/34353297838",
  "reason": "Inspect deployment evidence, complete approved data removal, verify path absence, then re-evaluate parent acceptance."
}
```

The tool is `initiative_delivery_followup`. Alternatively supply `child_issue`
(a readable ID) for a descendant. Exactly one condition is required. A workflow
condition identifies one immutable run, not latest main. Both success and
failure/cancellation wake the owner; the result never directly closes an issue.
GitHub Enterprise is not supported by this initial executor.

## Executor installation is required

The harness cannot wake itself after it exits. Run the following from an
external scheduler, typically once per minute, as the authenticated agent OS
user with the same persistent `WORKGRAPH_DATA_DIR` and `MULTICA_WORKSPACE_ID`:

```bash
# Observe readiness only; updates local observations, never enqueues a run.
workgraph followups --json
# Explicitly enable resuming current issue assignments.
workgraph followups --dispatch --json
```

Use the installed package's executable or absolute `dist/src/cli.js` path with
the supported Node runtime. The executor needs Multica CLI authentication;
workflow conditions also require authenticated `gh` access to those repositories.
It needs no Cognee credentials. Keep one deployment/server per data directory.
The companion `workgraph-workspace-v3.db.followups.db` is durable state and must
be included with the existing outbox in backup/recovery procedures.

A scheduler must provide the environment itself and monitor nonzero exits.
`initiative_delivery_status.executor` exposes the last dispatch-poll heartbeat
and whether it was observed within five minutes. No heartbeat means no evidence
of an active executor; registering a watch does not install a scheduler. This PR
does not modify the Devbox deployment or enable production dispatch.

The executor revalidates workspace, root ancestry and the owner's original
assignment before dispatch. It waits while the owner has active runs. SQLite
compare-and-set plus a per-owner reservation prevents overlapping workers and
multiple ready conditions from immediately duplicating a dispatch. Multica's
active-run check is advisory; other clients can independently enqueue work.
Read failures stay waiting for the next poll, with sanitized diagnostics.

A rerun has no server idempotency key. The executor therefore reserves before
sending it. A timeout or crash leaves `dispatching`, reports an error, and does
not blindly retry. Inspect Multica runs first. The exported `FollowupStore`
`transition(id, 'dispatching', 'dispatched')` acknowledges a confirmed enqueue;
transition back to `waiting` only after proving no run was created. The same
inspection is necessary if the process died between reservation and request.
Ownership/ancestry changes stay visible for operator reconciliation; create a
new correctly owned watch after reviewing the new scope.

Dispatched watches are one-shot and idempotent. A resumed owner reads the reason
and observation through `initiative_delivery_status`, verifies acceptance and
completes or recovers its work. If another deployment is necessary it registers
that new exact run. No unbounded automatic retry loop or automatic issue closure
is introduced. Deliveries that never register an external wait still need a
watch; prompts instruct agents to register before stopping.

## Acceptance before rollout

1. Run `npm run check` and the regression for B-226-style handoff repair.
2. In a test workspace, register a workflow wait; keep the owner idle.
3. Restart the harness and executor. Finish/fail the workflow and verify exactly
   one owner run. Verify the resumed prompt includes reason and observation.
4. Complete a child only after its actual acceptance checks. Verify the parent
   resumes, reads the child's authoritative state and checks its own criteria.
5. Simulate API failure, changed assignment and ambiguous dispatch; ensure each
   is visible and does not silently disappear or repeatedly enqueue runs.
