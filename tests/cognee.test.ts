import { describe, expect, it, vi } from "vitest";
import { CogneeApiClient } from "../src/cognee.js";

const initiative = "00000000-0000-4000-8000-000000000001";
const dataset = `brwsr-initiative-${initiative}`;

describe("Cognee remote transport", () => {
  it("routes recall only to the configured endpoint and locked dataset", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const client = new CogneeApiClient({
      serviceUrl: "https://tenant.example.test/cognee/",
      apiKey: "test-key",
      fetch: fetch as typeof globalThis.fetch,
    });
    await client.recall("What changed?", dataset, 7);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://tenant.example.test/cognee/api/v1/search");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "What changed?", datasets: [dataset], search_type: "GRAPH_COMPLETION", top_k: 7,
    });
    expect(new Headers(init.headers).get("X-Api-Key")).toBe("test-key");
  });

  it("sends structured records through remote remember", async () => {
    const fetch = vi.fn(async () => new Response("{}", {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const client = new CogneeApiClient({
      serviceUrl: "http://127.0.0.1:8000",
      apiKey: "local-token",
      authScheme: "bearer",
      fetch: fetch as typeof globalThis.fetch,
    });
    await client.remember({
      entity_type: "Decision", authority: "confirmed", initiative_id: initiative,
      entity_id: "decision:test", summary: "Scoped.", relations: [],
      source: "multica://issues/test", observed_at: "2026-08-30T09:00:00.000Z",
    }, dataset, "payload-hash");
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:8000/api/v1/remember");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer local-token");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("payload-hash");
    expect((init.body as FormData).get("datasetName")).toBe(dataset);
  });
});
