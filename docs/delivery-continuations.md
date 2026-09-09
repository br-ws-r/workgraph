# Delivery observations and incident repair

B-226 exposed two separate problems: authored `IN PROGRESS —` and `Merged.`
comments were skipped by a period-only parser, and a completed agent run left
an unfinished issue with no observed execution. Workgraph preserves evidence
and makes that gap visible. It does not guarantee agent continuation.

## Upstream Multica contract

`initiative_delivery_status` uses existing `issue get`, `issue children` and
`issue runs --active` CLI commands, verified against upstream Multica 0.4.40.
No fork, custom endpoint, callback receiver, dispatch queue or heartbeat is
required. Multica remains the authority for status, ownership and execution.
A Markdown attachment is supporting detail; it is not a dispatch instruction.

The result includes the observation timestamp, selected issue, complete direct
children, active-run counts, capture audit and recent local handoffs. Reads are
successive observations, not an atomic server snapshot or an execution lock.

- `open_issue_without_active_run`: an actionable issue has no observed active run.
- `current_run_has_no_observed_successor`: only the current run is observed.
- `active_runs_unavailable`: the CLI failed or returned an invalid response;
  counts are unknown, never silently zero.
- `all_children_terminal_acceptance_requires_review`: all direct children are
  done/cancelled but the parent still needs its own acceptance assessment.

Active runs must have valid IDs, exact issue/workspace scope, unique identities
and an upstream active status. A run waiting for a local directory is in flight,
not proof that an agent can make progress. Another active run is not proof of
an intended handoff. External waits, human gates and inactive agents cannot be
inferred from an empty active-run list; warnings are observations, not verdicts.
The receiving/owning agent must use the workspace's existing Multica assignment
or mention flow and verify the exact intended subsequent run before claiming
handoff. An agent may instead finish authorized work in the current run.

## Capture and repair

Handoffs accept case-insensitive DONE, BLOCKED, IN PROGRESS, NEEDS DECISION,
MERGED and DECISION RESOLVED prefixes with period, colon, dash or Markdown bold
markers. Only the first bounded paragraph of an authored agent comment with
server task provenance is captured. Attachments and transcripts stay excluded;
credential-pattern rejection remains in place. Capture audit exposes both
accepted records and rejection reasons.

Normal capture baselines existing comments. For an affected selected issue,
call `initiative_handoffs_repair` with an explicit RFC3339 `since` timestamp.
B-226's incident boundary is `2026-09-09T00:00:00Z`. Repair reconsiders previously
seen comments, retains source IDs and timestamps, deduplicates events and
rejects truncated history. It queues semantic records; use `initiative_timeline`
for delivery evidence and recall to verify remote readability.

## Graph and acceptance

Distinct fresh issue snapshots produce Issue records with explicit `child_of`
and `part_of` relations in the verified root initiative. These become historical
observations in Cognee, not a replacement for current Multica reads. Handoff
records remain linked to their issue and original comment provenance.

A merged PR, completed agent run, terminal child or remembered report does not
prove delivery. Verify repository review gates, required deployment and any
required data operation separately. Never close a parent merely because all its
children are terminal; cancellation and independent acceptance require review.

## Package validation

Run `npm run check`. This covers malformed/foreign execution responses, unknown
versus empty execution state, B-226-style handoff replay, graph edges and the
actual npm tarball installed without Pi runtime dependencies. The public 0.2.0
package retains the existing publish configuration. Build output is cleaned so
removed scheduler modules cannot survive in an npm release.
