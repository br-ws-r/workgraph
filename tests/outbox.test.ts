import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkgraphOutbox } from "../src/outbox.js";

const initiative = "00000000-0000-4000-8000-000000000001";

describe("durable outbox", () => {
  it("is idempotent across concurrent Pi process connections", () => {
    const path = join(mkdtempSync(join(tmpdir(), "workgraph-")), "outbox.db");
    const first = new WorkgraphOutbox(path);
    const second = new WorkgraphOutbox(path);
    const input = {
      eventId: "00000000-0000-4000-8000-000000000099",
      initiativeId: initiative,
      eventType: "decision_recorded" as const,
      boundedSummary: "One event.",
      source: "multica://issues/test",
      authority: "confirmed" as const,
    };
    first.append(input);
    second.append(input);
    expect(first.timeline(initiative)).toHaveLength(1);
    first.close();
    second.close();
  });

  it("orders the exact timeline and retains failed deliveries", () => {
    const path = join(mkdtempSync(join(tmpdir(), "workgraph-")), "outbox.db");
    const outbox = new WorkgraphOutbox(path);
    const event = outbox.append({
      timestamp: "2026-08-30T09:00:00.000Z",
      initiativeId: initiative,
      eventType: "decision_recorded",
      boundedSummary: "Scoped decision.",
      source: "multica://issues/test",
      authority: "confirmed",
      memoryRecord: {
        entity_type: "Decision", authority: "confirmed", initiative_id: initiative,
        entity_id: "decision:test", summary: "Scoped decision.", relations: [],
        source: "multica://issues/test", observed_at: "2026-08-30T09:00:00.000Z",
      },
    });
    outbox.markFailed(event.eventId, "offline");
    expect(outbox.pending()).toHaveLength(1);
    expect(outbox.timeline(initiative)[0]).toMatchObject({ deliveryAttempts: 1, lastDeliveryError: "offline" });
    outbox.close();
  });
});
