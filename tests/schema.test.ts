import { describe, expect, it } from "vitest";
import {
  AUTHORITY_LEVELS,
  EDGE_TYPES,
  EXTRACTION_PROMPT,
  EXTRACTION_PROMPT_VERSION,
  SCHEMA_VERSION,
  MemoryRecordSchema,
  NODE_TYPES,
  createEvent,
  datasetForWorkspace,
  deriveNodeSets,
  initiativeNodeSet,
} from "../src/schema.js";

const workspace = "00000000-0000-4000-8000-000000000010";
const initiative = "00000000-0000-4000-8000-000000000001";
const issue = "00000000-0000-4000-8000-000000000002";

function record(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
    workspace_id: workspace,
    initiative_id: initiative,
    initiative_identifier: "B-184",
    issue_id: issue,
    entity_type: "Decision",
    authority: "confirmed",
    entity_id: "decision:workspace-memory",
    summary: "Keep memory scoped.",
    relations: [{ type: "about", target: `issue:${initiative}` }],
    node_sets: ["initiative:B-184", "type:decision", "authority:confirmed"],
    source: `multica://issues/${issue}`,
    observed_at: "2026-09-04T09:00:00.000Z",
    ...overrides,
  };
}

describe("workspace memory schema", () => {
  it("defines the accepted generic ontology and versioned extraction prompt", () => {
    expect(NODE_TYPES).toEqual([
      "Initiative", "Issue", "Task", "Agent", "Squad", "Decision", "Constraint",
      "Risk", "Blocker", "Handoff", "Artifact", "Evidence", "Run", "Outcome", "Conflict",
    ]);
    expect(EDGE_TYPES).toEqual([
      "root_of", "child_of", "part_of", "assigned_to", "owned_by", "delegated_to",
      "blocked_by", "depends_on", "produced", "supports", "contradicts", "derived_from",
      "about", "verified_by", "resulted_in", "observed_in", "related_to",
    ]);
    expect(AUTHORITY_LEVELS).toContain("confirmed");
    expect(EXTRACTION_PROMPT).toContain(SCHEMA_VERSION);
    expect(EXTRACTION_PROMPT).toContain("Constraint");
  });

  it("derives one stable dataset from the workspace UUID", () => {
    expect(datasetForWorkspace(workspace)).toBe(`workgraph-workspace-${workspace}`);
    expect(datasetForWorkspace(workspace.toUpperCase())).toBe(`workgraph-workspace-${workspace}`);
  });

  it("rejects invalid workspaces", () => {
    expect(() => datasetForWorkspace("workspace")).toThrow();
  });

  it("derives bounded mandatory and verified optional NodeSets deterministically", () => {
    const input = {
      initiativeIdentifier: " B-184 ", entityType: "Decision" as const,
      authority: "confirmed" as const,
      projectId: "00000000-0000-4000-8000-000000000099",
      parentIssueId: issue, stage: 3, repositoryIdentifier: "br-ws-r/workgraph",
    };
    const derived = deriveNodeSets(input);
    expect(derived.slice(0, 5)).toEqual([
      "initiative:B-184", "type:decision", "authority:confirmed",
      "project:00000000-0000-4000-8000-000000000099", `stage:${issue}-3`,
    ]);
    expect(derived[5]).toMatch(/^repo:br-ws-r-workgraph-[a-f0-9]{10}$/);
    expect(derived).toEqual(deriveNodeSets(input));
  });

  it("bounds and sanitizes NodeSet values without accepting caller labels", () => {
    expect(deriveNodeSets({
      initiativeIdentifier: `B-${"x".repeat(200)}`,
      entityType: "Risk",
      authority: "observed",
    })[0]).toHaveLength(107);
    expect(() => deriveNodeSets({
      initiativeIdentifier: "///", entityType: "Risk", authority: "observed",
    })).toThrow("no safe characters");
    expect(() => MemoryRecordSchema.parse(record({
      node_sets: ["initiative:B-184", "type:decision", "authority:confirmed", "team:anything"],
    }))).toThrow();
    expect(initiativeNodeSet("A/B")).not.toBe(initiativeNodeSet("A-B"));
    expect(deriveNodeSets({
      initiativeIdentifier: "B-184", entityType: "Risk", authority: "observed", stage: 3,
    })).toEqual(["initiative:B-184", "type:risk", "authority:observed"]);
    expect(() => MemoryRecordSchema.parse(record({ stage: 0 }))).toThrow();
  });

  it("requires the workspace envelope, provenance, versions, and exact derived NodeSets", () => {
    expect(MemoryRecordSchema.parse(record())).toMatchObject({
      workspace_id: workspace, initiative_id: initiative, initiative_identifier: "B-184", issue_id: issue,
    });
    for (const field of [
      "schema_version", "extraction_prompt_version", "workspace_id", "initiative_id",
      "initiative_identifier", "issue_id", "node_sets", "authority", "source", "observed_at",
    ]) {
      const invalid = record();
      delete invalid[field];
      expect(MemoryRecordSchema.safeParse(invalid).success, field).toBe(false);
    }
    expect(() => MemoryRecordSchema.parse(record({ schema_version: "future" }))).toThrow();
    expect(() => MemoryRecordSchema.parse(record({ node_sets: [
      "initiative:B-184", "type:decision", "authority:confirmed", "repo:unverified",
    ] }))).toThrow("server-derived scope");
  });

  it("accepts optional NodeSets only when their structured metadata matches", () => {
    expect(MemoryRecordSchema.parse(record({
      project_id: "00000000-0000-4000-8000-000000000099",
      parent_issue_id: issue, stage: 2,
      repository_identifier: "br-ws-r/workgraph",
      node_sets: [
        "initiative:B-184", "type:decision", "authority:confirmed",
        "project:00000000-0000-4000-8000-000000000099",
        `stage:${issue}-2`, deriveNodeSets({
          initiativeIdentifier: "B-184", entityType: "Decision", authority: "confirmed",
          projectId: "00000000-0000-4000-8000-000000000099",
          parentIssueId: issue, stage: 2, repositoryIdentifier: "br-ws-r/workgraph",
        })[5],
      ],
    })).node_sets).toHaveLength(6);
  });

  it("bounds semantic records to one chunk and rejects inconsistent event envelopes", () => {
    expect(() => MemoryRecordSchema.parse(record({
      entity_id: "x".repeat(512), summary: "s".repeat(4000), source: "p".repeat(1000),
      relations: Array.from({ length: 25 }, () => ({ type: "about", target: "t".repeat(512) })),
    }))).toThrow("single-chunk");

    const memoryRecord = MemoryRecordSchema.parse(record());
    expect(() => createEvent({
      workspaceId: workspace,
      initiativeId: initiative,
      initiativeIdentifier: "B-184",
      issueId: "00000000-0000-4000-8000-000000000099",
      nodeSets: memoryRecord.node_sets,
      schemaVersion: SCHEMA_VERSION,
      extractionPromptVersion: EXTRACTION_PROMPT_VERSION,
      eventType: "decision_recorded",
      boundedSummary: memoryRecord.summary,
      source: memoryRecord.source,
      authority: memoryRecord.authority,
      memoryRecord,
    })).toThrow("envelope");
  });
});
