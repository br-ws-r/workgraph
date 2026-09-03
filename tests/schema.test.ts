import { describe, expect, it } from "vitest";
import { MemoryRecordSchema, datasetForInitiative } from "../src/schema.js";

const initiative = "00000000-0000-4000-8000-000000000001";

describe("initiative memory schema", () => {
  it("derives one stable dataset from the root issue UUID", () => {
    expect(datasetForInitiative(initiative)).toBe(`workgraph-initiative-${initiative}`);
    expect(datasetForInitiative(initiative, "brwsr-initiative")).toBe(`brwsr-initiative-${initiative}`);
  });

  it("rejects unsafe dataset prefixes", () => {
    expect(() => datasetForInitiative(initiative, "Other Dataset")).toThrow();
    expect(() => datasetForInitiative(initiative, "../other")).toThrow();
  });

  it("requires provenance, timestamp, and authority", () => {
    expect(() => MemoryRecordSchema.parse({
      entity_type: "Decision",
      initiative_id: initiative,
      entity_id: "decision:test",
      summary: "Keep memory scoped.",
      source: "multica://issues/test",
      observed_at: new Date().toISOString(),
    })).toThrow();
  });
});
