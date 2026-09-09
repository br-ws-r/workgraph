# Native delivery contract

Version: `multica-delivery/v1`.

Multica owns issue status, accountable assignment, source runs, continuation
records and the execution queue. Workgraph consumes those records as sourced
observations in Cognee. Cognee availability never determines whether a successor
is queued, a deployment callback is acknowledged, or an issue may complete.

| Native record | Graph representation | Relationships |
| --- | --- | --- |
| Issue | Issue | `child_of` parent, `part_of` initiative |
| Source run | Run | continuation `derived_from` run |
| Continuation | Handoff | `about` issue, `delegated_to` agent |
| Successor run | Run | continuation `resulted_in` run |
| PR, deployment report | Artifact / Evidence | sourced revision and URL |

`waiting`, `dispatched` and `blocked` describe a continuation, not issue status.
A dispatched continuation carries a concrete successor task ID. A waiting
continuation carries the exact event key and next action in Multica. A deployment
success means the event arrived; the agent still verifies issue acceptance.
Markdown reports are optional detailed evidence and never a routing protocol.

`initiative_delivery_status` reads the current issue, direct children and native
continuations. Unsupported or unavailable continuation reads are explicitly
`unavailable`, not an empty queue. Graph snapshots retain their source revision;
old snapshots are historical observations, not live control state.

Handoff capture accepts the real comment prefixes used by Workbook, including
punctuation variants, and records a reason for every accepted or skipped comment.
`initiative_handoffs_repair` reconsiders an explicit bounded history without
resetting cursors or dispatching agents. Repeated repairs are idempotent.

There is no Workgraph scheduler, heartbeat or secondary continuation database.
The native API and CLI are implemented in the accompanying Multica change;
Workbook installs the agent instructions only after that capability is deployed.
