import { describe, expect, it, vi } from "vitest";
import { EXTRACTION_PROMPT, EXTRACTION_PROMPT_VERSION, SCHEMA_VERSION } from "../src/schema.js";
import { CogneeApiClient, createCogneeClientFromEnv } from "../src/cognee.js";

const workspace = "00000000-0000-4000-8000-000000000010";
const initiative = "00000000-0000-4000-8000-000000000001";
const issue = "00000000-0000-4000-8000-000000000002";
const dataset = "workgraph-workspace-brwsr";

describe("Cognee remote transport", () => {
  it("routes recall only to the configured endpoint and locked dataset", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([{
      source: "graph", kind: "chunk", search_type: "CHUNKS", text: "Scoped result",
      dataset_id: "dataset-id", dataset_name: dataset, metadata: { chunk_id: "chunk-1" },
    }]), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const client = new CogneeApiClient({
      serviceUrl: "https://tenant.example.test/cognee/",
      apiKey: "test-key",
      tenantId: "test-tenant",
      fetch: fetch as typeof globalThis.fetch,
    });
    expect(await client.recall("What changed?", dataset, {
      topK: 7, nodeNames: ["initiative:B-184"],
    })).toEqual([{
      source: "graph", kind: "chunk", searchType: "CHUNKS", text: "Scoped result",
      datasetId: "dataset-id", datasetName: dataset, metadata: { chunk_id: "chunk-1" },
    }]);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://tenant.example.test/cognee/api/v1/recall");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "What changed?", datasets: [dataset], search_type: "CHUNKS",
      node_name: ["initiative:B-184"], top_k: 7, only_context: false,
      include_references: false,
    });
    expect(new Headers(init.headers).get("X-Api-Key")).toBe("test-key");
    expect(new Headers(init.headers).get("X-Tenant-Id")).toBe("test-tenant");
  });

  it("sends structured records through remote remember", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "completed" }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const client = new CogneeApiClient({
      serviceUrl: "http://127.0.0.1:8000",
      apiKey: "local-token",
      authScheme: "bearer",
      fetch: fetch as typeof globalThis.fetch,
    });
    await client.remember({
      schema_version: SCHEMA_VERSION, extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
      workspace_id: workspace, workspace_identifier: "brwsr", workspace_name: "BRWSR",
      initiative_identifier: "B-184", issue_id: issue, issue_identifier: "B-185",
      entity_type: "Decision", authority: "confirmed", initiative_id: initiative,
      entity_identifier: "decision:test", entity_label: "Test decision", summary: "Scoped.",
      relations: [{ type: "about", target: "issue:B-185" }],
      node_sets: ["initiative:B-184", "type:decision", "authority:confirmed"],
      source: "multica://issues/B-185", observed_at: "2026-08-30T09:00:00.000Z",
    }, dataset, "payload-hash");
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:8000/api/v1/remember");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer local-token");
    expect(new Headers(init.headers).has("X-Tenant-Id")).toBe(false);
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("payload-hash");
    expect((init.body as FormData).get("datasetName")).toBe(dataset);
    expect((init.body as FormData).get("run_in_background")).toBe("false");
    expect((init.body as FormData).get("chunk_size")).toBe("16384");
    expect((init.body as FormData).getAll("node_set")).toEqual([
      "initiative:B-184", "type:decision", "authority:confirmed",
    ]);
    expect((init.body as FormData).get("custom_prompt")).toBe(EXTRACTION_PROMPT);
    const file = (init.body as FormData).get("data") as File;
    expect(file.name).toBe("test-decision-payload-ha.txt");
    const document = await file.text();
    expect(document).toContain('{"identifier":"decision:test","type":"Decision"}');
    expect(document).toContain('{"identifier":"issue:B-185","type":"Issue"}');
    expect(document).toContain('{"source":"decision:test","type":"about","target":"issue:B-185"}');
    expect(document).toContain("WORKGRAPH_RECORD_V1\n{");
    expect(JSON.parse(document.split("WORKGRAPH_RECORD_V1\n")[1])).toMatchObject({
      entity_identifier: "decision:test",
      issue_identifier: "B-185",
    });
  });

  it("supports unauthenticated loopback self-hosting", async () => {
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const client = new CogneeApiClient({
      serviceUrl: "http://127.0.0.1:8000",
      authScheme: "none",
      fetch: fetch as typeof globalThis.fetch,
    });

    await client.health();

    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("X-Api-Key")).toBe(false);
    expect(createCogneeClientFromEnv({
      COGNEE_SERVICE_URL: "http://127.0.0.1:8000",
      COGNEE_AUTH_SCHEME: "none",
    })).toBeInstanceOf(CogneeApiClient);
  });

  it("rejects malformed Recall responses and errored Remember results", async () => {
    const responses = [
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ status: "errored", error: "pipeline failed" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    ];
    const client = new CogneeApiClient({
      serviceUrl: "http://127.0.0.1:8000", authScheme: "none",
      fetch: vi.fn(async () => responses.shift()!) as typeof globalThis.fetch,
    });
    await expect(client.recall("query", dataset)).rejects.toThrow("not a list");
    await expect(client.remember({
      schema_version: SCHEMA_VERSION, extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
      workspace_id: workspace, workspace_identifier: "brwsr", initiative_id: initiative, initiative_identifier: "B-184",
      issue_id: issue, issue_identifier: "B-185", entity_type: "Outcome", authority: "observed",
      entity_identifier: "outcome:1", entity_label: "B-185 outcome", summary: "Finished.", relations: [],
      node_sets: ["initiative:B-184", "type:outcome", "authority:observed"],
      source: "multica://issues/B-185", observed_at: "2026-09-04T12:00:00.000Z",
    }, dataset, "hash")).rejects.toThrow("pipeline failed");
  });

  it("rejects unrecognized chunks and incomplete ingestion", async () => {
    const responses = [
      new Response(JSON.stringify([{ kind: "chunk", text: 42 }]), {
        status: 200, headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ status: "running", pipeline_run_id: "run-1" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    ];
    const client = new CogneeApiClient({
      serviceUrl: "http://127.0.0.1:8000", authScheme: "none",
      fetch: vi.fn(async () => responses.shift()!) as typeof globalThis.fetch,
    });
    await expect(client.recall("query", dataset)).rejects.toThrow("unsupported shape");
    await expect(client.remember({
      schema_version: SCHEMA_VERSION, extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
      workspace_id: workspace, workspace_identifier: "brwsr", initiative_id: initiative, initiative_identifier: "B-184",
      issue_id: issue, issue_identifier: "B-185", entity_type: "Outcome", authority: "observed",
      entity_identifier: "outcome:1", entity_label: "B-185 outcome", summary: "Finished.", relations: [],
      node_sets: ["initiative:B-184", "type:outcome", "authority:observed"],
      source: "multica://issues/B-185", observed_at: "2026-09-04T12:00:00.000Z",
    }, dataset, "hash")).rejects.toThrow("did not complete: running");
  });

  it("disables invalid timeout configuration", () => {
    expect(createCogneeClientFromEnv({
      COGNEE_SERVICE_URL: "http://127.0.0.1:8000", COGNEE_AUTH_SCHEME: "none",
      WORKGRAPH_COGNEE_TIMEOUT_MS: "invalid",
    })).toBeUndefined();
  });
});
