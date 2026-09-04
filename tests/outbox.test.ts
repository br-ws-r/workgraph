import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkgraphOutbox, type OutboxEventInput } from "../src/outbox.js";

const workspaceA = "00000000-0000-4000-8000-000000000010";
const workspaceB = "00000000-0000-4000-8000-000000000020";
const initiative = "00000000-0000-4000-8000-000000000001";

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "workgraph-")), "outbox.db");
}

function eventInput(overrides: Partial<OutboxEventInput> = {}): OutboxEventInput {
  const workspaceId = overrides.workspaceId ?? workspaceA;
  return {
    workspaceId,
    initiativeId: initiative,
    initiativeIdentifier: "WG-1",
    issueId: "00000000-0000-4000-8000-000000000002",
    projectId: "00000000-0000-4000-8000-000000000011",
    eventType: "decision_recorded",
    boundedSummary: "Scoped decision.",
    source: "multica://issues/test",
    authority: "confirmed",
    nodeSets: [
      "initiative:WG-1", "type:decision", "authority:confirmed",
      "project:00000000-0000-4000-8000-000000000011",
    ],
    schemaVersion: "2.0.0",
    extractionPromptVersion: "1.0.0",
    memoryRecord: {
      schema_version: "2.0.0", extraction_prompt_version: "1.0.0",
      workspace_id: workspaceId,
      entity_type: "Decision", authority: "confirmed", initiative_id: initiative,
      initiative_identifier: "WG-1",
      issue_id: "00000000-0000-4000-8000-000000000002",
      project_id: "00000000-0000-4000-8000-000000000011",
      entity_id: "decision:test", summary: "Scoped decision.", relations: [],
      node_sets: [
        "initiative:WG-1", "type:decision", "authority:confirmed",
        "project:00000000-0000-4000-8000-000000000011",
      ],
      source: "multica://issues/test", observed_at: "2026-08-30T09:00:00.000Z",
    },
    ...overrides,
  };
}

describe("workspace outbox", () => {
  it("idempotently appends through concurrent connections without replacing payload", () => {
    const path = databasePath();
    const first = new WorkgraphOutbox(path);
    const second = new WorkgraphOutbox(path);
    const eventId = "00000000-0000-4000-8000-000000000099";

    first.append(eventInput({ eventId, boundedSummary: "Original payload." }));
    second.append(eventInput({ eventId, boundedSummary: "Replacement payload." }));

    expect(first.timeline(initiative)).toHaveLength(1);
    expect(second.get(eventId)).toMatchObject({
      boundedSummary: "Original payload.",
      workspaceId: workspaceA,
      initiativeIdentifier: "WG-1",
      issueId: "00000000-0000-4000-8000-000000000002",
      projectId: "00000000-0000-4000-8000-000000000011",
      nodeSets: [
        "initiative:WG-1", "type:decision", "authority:confirmed",
        "project:00000000-0000-4000-8000-000000000011",
      ],
      schemaVersion: "2.0.0",
      extractionPromptVersion: "1.0.0",
    });
    first.close();
    second.close();
  });

  it("filters pending in SQL so another workspace cannot starve the requested workspace", () => {
    const outbox = new WorkgraphOutbox(databasePath());
    for (let index = 0; index < 8; index += 1) {
      outbox.append(eventInput({ eventId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
    }
    const other = outbox.append(eventInput({
      eventId: "00000000-0000-4000-8000-000000000200",
      workspaceId: workspaceB,
    }));

    expect(outbox.pending(workspaceB, 1).map((event) => event.eventId)).toEqual([other.eventId]);
    expect(outbox.pending(workspaceA, 2)).toHaveLength(2);
    outbox.close();
  });

  it("atomically gives concurrent connections exclusive ordered claims", () => {
    const path = databasePath();
    const first = new WorkgraphOutbox(path);
    const second = new WorkgraphOutbox(path);
    for (let index = 0; index < 4; index += 1) {
      first.append(eventInput({
        eventId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        timestamp: `2026-08-30T09:00:0${3 - index}.000Z`,
      }));
    }

    const firstClaim = first.claimPending(workspaceA, "worker-a", 2, 10_000);
    const secondClaim = second.claimPending(workspaceA, "worker-b", 4, 10_000);

    expect(firstClaim.map((event) => event.sequence)).toEqual([1, 2]);
    expect(secondClaim.map((event) => event.sequence)).toEqual([3, 4]);
    expect(new Set([...firstClaim, ...secondClaim].map((event) => event.eventId))).toHaveLength(4);
    expect(firstClaim.every((event) => event.claimedBy === "worker-a")).toBe(true);
    first.close();
    second.close();
  });

  it("makes abandoned claims available after lease expiry", async () => {
    const path = databasePath();
    const first = new WorkgraphOutbox(path);
    const second = new WorkgraphOutbox(path);
    const event = first.append(eventInput());

    expect(first.claimPending(workspaceA, "stopped-worker", 1, 20)).toHaveLength(1);
    expect(second.claimPending(workspaceA, "next-worker", 1, 1000)).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.markDelivered(event.eventId, "stopped-worker")).toBe(false);
    expect(second.claimPending(workspaceA, "next-worker", 1, 1000)[0]).toMatchObject({
      eventId: event.eventId,
      claimedBy: "next-worker",
    });
    first.close();
    second.close();
  });

  it("enforces claim ownership when requested and clears successful claims", () => {
    const outbox = new WorkgraphOutbox(databasePath());
    const event = outbox.append(eventInput());
    outbox.claimPending(workspaceA, "worker-a", 1, 10_000);

    expect(outbox.markDelivered(event.eventId, "worker-b")).toBe(false);
    expect(outbox.get(event.eventId).claimedBy).toBe("worker-a");
    expect(outbox.markDelivered(event.eventId, "worker-a", "2026-09-04T10:00:00.000Z")).toBe(true);
    expect(outbox.get(event.eventId)).toMatchObject({
      deliveryAttempts: 1,
      deliveredAt: "2026-09-04T10:00:00.000Z",
      claimedBy: undefined,
      claimExpiresAt: undefined,
    });
    expect(outbox.pending(workspaceA)).toHaveLength(0);
    outbox.close();
  });

  it("retains failures for retry, bounds errors, and releases their claims", () => {
    const outbox = new WorkgraphOutbox(databasePath());
    const event = outbox.append(eventInput());
    outbox.claimPending(workspaceA, "worker-a", 1, 10_000);

    expect(outbox.markFailed(event.eventId, "x".repeat(1200), "worker-b")).toBe(false);
    expect(outbox.markFailed(event.eventId, "x".repeat(1200), "worker-a")).toBe(true);
    expect(outbox.get(event.eventId)).toMatchObject({
      deliveryAttempts: 1,
      claimedBy: undefined,
      claimExpiresAt: undefined,
    });
    expect(outbox.get(event.eventId).lastDeliveryError).toHaveLength(1000);
    expect(outbox.pending(workspaceA).map((pending) => pending.eventId)).toEqual([event.eventId]);
    expect(outbox.claimPending(workspaceA, "worker-b", 1, 1000)).toHaveLength(1);
    outbox.close();
  });

  it("keeps initiative timelines ordered by timestamp and append sequence", () => {
    const outbox = new WorkgraphOutbox(databasePath());
    const later = outbox.append(eventInput({ timestamp: "2026-09-04T10:00:01.000Z" }));
    const earlier = outbox.append(eventInput({ timestamp: "2026-09-04T10:00:00.000Z" }));
    const sameTime = outbox.append(eventInput({ timestamp: "2026-09-04T10:00:01.000Z" }));

    expect(outbox.timeline(initiative).map((event) => event.eventId)).toEqual([
      earlier.eventId, later.eventId, sameTime.eventId,
    ]);
    outbox.close();
  });
});
