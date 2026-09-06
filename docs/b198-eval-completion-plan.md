# B-198 Workgraph Pi ↔ OMP relay: completion and hardening plan

## Purpose

This plan closes the in-progress Multica evaluation **B-198** without treating
Cognee memory as workflow authority. It also makes the next staged relay
repeatable: every participant must have a real Cognee delivery and a
cross-runtime recall before the initiative can be declared successful.

The authoritative state is Multica. Workgraph's SQLite timeline is the exact
delivery ledger and Cognee is the semantic-memory backend; neither may silently
advance issue statuses.

## Verified state at 2026-09-06

| Item | State | Evidence |
| --- | --- | --- |
| Parent B-198 | `in_progress` | It has no automatic terminal transition. |
| B-199, PM / Pi | `done` | Write was delivered on the first attempt and recalled by Admin. |
| B-200, Admin / OMP | `done` | Recalled the Pi seed; its own record was delivered and read back. |
| B-201, Developer / OMP | `done` | Recalled Admin and delivered the Developer record. |
| B-202, Reviewer / OMP | `done` | Recalled Developer and delivered the Reviewer record. |
| B-203, Theon / Pi | `in_review` | Theon reported delivered timeline entries; its comments do not establish a successful Cognee recall. |
| B-204, Planner / OMP | `backlog` | It has never been promoted to `todo`. |

The browser URL is authenticated-user-only in this environment. The facts above
come from the authenticated Multica CLI, issue comments, and task state; they
must be re-read in Multica immediately before any mutation.

## Root cause

The observed stall is an orchestration-state failure. The available comments
also leave the OMP → Pi remote-recall gate unverified; they do not establish
complete runtime parity or graph correctness.

1. A Multica stage barrier **notifies** the parent assignee when its last child
   is done. It does not automatically promote the following stage's `backlog`
   child to `todo`.
2. B-203 reported delivered local entries but ended as `in_review`, without a
   completed review handoff. Its predecessor verification explicitly cites the
   local timeline, which cannot substitute for Cognee recall.
   Stage 5 therefore did not complete, so PM was not notified to release B-204.
3. Even after every child is done, Multica does not infer that B-198 itself is
   done. Its owner must perform the final read, evaluate the stated acceptance
   criteria, and set the parent terminal status.

The first four stages show that the intended manual promotion loop worked. The
stalled fifth stage shows that the loop needs a terminal-status contract and a
defined recovery owner. The server transition history has not been audited to
attribute the final `in_review` transition to agent intent versus task finalization.

## Immediate recovery runbook

PM owns the parent and performs every status mutation only after a fresh
Multica read.

1. Read B-203, its comments, and its Workgraph evidence. Confirm that
   `5|Theon|silver-orbit|B084` has a `delivered` timeline entry, and obtain actual
   Cognee recall tool evidence for both predecessor and own record. The existing
   comments do not supply that evidence. If either check fails, return B-203 to
   `todo` and ask Theon to retry without a duplicate write; do not advance the relay.
2. If both checks pass, set B-203 to `done`. This completes Stage 5 and emits
   the normal parent notification.
3. Read B-204's description and B-203's completed evidence. If the preceding
   payload is verified, promote B-204 from `backlog` to `todo`; otherwise leave
   it in backlog and record the concrete blocker on the parent.
4. Planner must recall `5|Theon|silver-orbit|B084`, write and read back
   `6|Planner|golden-archive|D735`, and verify its own delivery as `delivered`.
   Follow Planner's existing intake rules before release. If its workflow
   requires review, hand off to PM for acceptance and the final `done` transition;
   no extra review child is necessary.
5. PM re-reads all six children and the parent. It verifies all six expected
   payloads, their expected writer/runtime hops, and an acknowledged delivery
   for every explicit relay record. Pending automatic status-event deliveries
   are reported separately and never substituted for an explicit relay result.
6. PM posts the concise final result through the normal agent handoff path and
   sets B-198 to `done` only if every acceptance condition passes. On any failed
   or missing hop, set B-198 to `blocked`, name the failed task and evidence,
   and preserve the remaining children for recovery rather than declaring a
   partial success.

## Durable orchestration changes

### 1. Make the stage gate explicit in every evaluation parent

The parent description and PM handoff must say that stages are manual release
gates. It must name PM as the release owner, the required `backlog` → `todo`
mutation, and the condition that permits it. Do not imply that Multica stages
auto-start the next child.

### 2. Use a terminal-status contract for every child

Every relay child must contain this rule:

> When the delivery and remote recall criteria pass, complete the child through
> the role's normal workflow. If that workflow ends at `in_review`, hand off to
> PM for acceptance and closure. PM must verify the actual `done` transition
> before releasing the next stage.

The parent completion checklist must reject `in_review`, `todo`, `blocked`, or
`backlog` children. A successful comment is evidence, not completion.

### 3. Separate delivery evidence from workflow-state noise

The final evaluator records two counters:

- explicit relay records: six expected, each delivered and recallable;
- automatic Multica activity records: informative audit evidence only.

This avoids counting automatic `status_changed` evidence as proof that an
agent wrote or recalled the intended memory.

### 4. Encode relay edges, not just record contents

Starting with the next evaluation, each writer supplies both:

- `derived_from` the preceding relay record; and
- `observed_in` its assigned `issue:B-…`.

The current default `about → initiative:B-198` relationship gives valid scope,
but it does not make the causal relay legible in the Cognee mindmap. The two
extra edges make the intended chain queryable without asking Cognee to infer
it from prose.

### 5. Add a final, independent verification task

Keep the sixth relay writer separate from parent closure. PM's parent-close
step must be an explicit verification checklist, not an inferred effect of the
last child completing. This preserves separation between evidence generation
and workflow authority.

### 6. Define lifecycle parity by delivery contract, not by hook name

Pi and OMP expose different points around the end of an agent run. Pi's
`agent_settled` runs after retries, compaction, and queued continuations finish.
OMP 18.1.11's `session_stop` runs when a main-agent turn is about to settle and
handlers can request continuation. It does **not** mean closing the session;
`session_shutdown` is separate. The OMP adapter waits for idle with no pending
messages, and must discard callbacks after cancellation, a new turn, or shutdown.
Sources: [OMP 18.1.11 event definitions](https://github.com/can1357/oh-my-pi/blob/v18.1.11/packages/coding-agent/src/extensibility/shared-events.ts)
and the installed Pi 0.84.4 `AgentSettledEvent` definition.

The durable contract is already shared in the runtime: every explicit
`initiative_memory_remember` appends to the durable outbox and immediately
schedules a Cognee flush. The lifecycle hook is only the additional point for
reconciling automatic Multica activity and draining remaining work. Keep that
shared write/flush path and retain host-specific safe boundaries.

For release confidence, add tests which assert the contract rather than hook
name equality:

- an explicit write schedules one delivery attempt in both hosts without waiting
  for a session boundary;
- Pi settles after its safe turn boundary;
- OMP settles only after `session_stop`, idle, and no pending messages; and
- either host leaves an interrupted write durably pending for the next run.

This prevents stale settlement reconciliation. Explicit flushes already run
while agents work and must remain independent of these lifecycle boundaries.

## Product follow-ups for Workgraph

These are separate implementation candidates; they are not prerequisites for
the B-198 recovery.

1. Add deterministic exact-identifier lookup in the local ledger and exact-ID
   filtering of remote recall. B-199 showed an ID-only semantic miss. The
   [Cognee Recall API](https://docs.cognee.ai/api-reference/recall/recall) does not
   document a Workgraph entity-key lookup. Keep CHUNKS retrieval and retry once
   with a local label/summary when available, always validating the remote ID
   and scope. This improves retrieval but cannot guarantee discovery. A local
   match must never be returned as proof of Cognee recall.
2. Make `initiative_memory_remember` expose a delivery-check affordance or a
   stable event identifier. It currently returns `queued`; callers must make a
   second timeline call to distinguish queued from delivered.
3. Add a live Pi → OMP → Pi end-to-end release test in a controlled test
   workspace. Unit tests currently validate the OMP adapter with a mocked host;
   B-198 is valuable live evidence but should not be the only regression gate.
4. Expose explicit/activity filters in Workgraph's timeline. Document the
   corresponding recommended Mindmap lens; that UI belongs to Cognee and its
   default cannot be changed by this extension. Do not discard activity data.

## Implementation and remaining release gates

The implementation branch provides stable write event IDs, exact scoped SQL
timeline filters, remote-only exact entity selection with one bounded query
hint retry, pending-write retry on startup/settlement, and OMP callback
cancellation. These reuse the current four tools and SQLite schema; no new
service, scheduler, host dependency, or graph migration is introduced.

The [live relay protocol](memory-relay-eval.md) supplies stage/review ownership,
canonical graph edge examples, evidence checks, and a final loop back to PM.
It fixes another limitation of B-198: every reader was given the expected token
in its task, so reproducing that token alone was not proof of memory retrieval.
New writers generate their own tokens and readers must retain remote tool output.

CI exercises both adapters with a real runtime, SQLite and HTTP serialization,
but simulated Cognee responses. Real host binaries, server deployment revision,
Cognee extraction fidelity, and live B-198 recovery remain release gates. Deploy
the reviewed revision through the owning Devbox workflow; any standing agent
instruction changes belong in Workbook. This code PR does not close Multica
issues, deploy the server, or edit the external Cognee Mindmap UI.

## Acceptance checklist

- [ ] B-203 has delivery and recall evidence and status `done`.
- [ ] B-204 has been manually released, completed, delivered, and recalled.
- [ ] The six relay payloads are present in order and attributed to the
      expected agents/runtimes.
- [ ] Each explicit relay record has `delivered` evidence; no pending record is
      counted as a success.
- [ ] Parent B-198 has a final PM verification handoff and status `done`, or a
      concrete `blocked` reason.
- [ ] A subsequent staged evaluation uses explicit relay graph relations and
      the terminal-status contract.
- [ ] Pi and OMP pass the shared delivery-contract tests while retaining their
      distinct safe lifecycle boundaries.
