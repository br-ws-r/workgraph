import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { WorkgraphOutbox, WorkgraphRuntime, CogneeApiClient, SCHEMA_VERSION, EXTRACTION_PROMPT_VERSION } from "@br-ws-r/workgraph/core";
import pi from "@br-ws-r/workgraph/pi";
import omp from "@br-ws-r/workgraph/omp";
import legacy from "@br-ws-r/workgraph";

const dataDir = mkdtempSync(join(tmpdir(), "workgraph-runtime-"));
const workspace = "00000000-0000-4000-8000-000000000010";
const issue = "00000000-0000-4000-8000-000000000001";
const record = {
  schema_version: SCHEMA_VERSION, extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
  workspace_id: workspace, workspace_identifier: "smoke", initiative_id: issue,
  initiative_identifier: "WG-1", issue_id: issue, issue_identifier: "WG-1",
  entity_type: "Decision", authority: "confirmed", entity_identifier: "decision:smoke",
  entity_label: "Smoke decision", summary: "Smoke test record", relations: [],
  node_sets: ["initiative:WG-1", "type:decision", "authority:confirmed"],
  source: "test://smoke", observed_at: "2026-09-06T00:00:00.000Z",
};
const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push({ path: request.url, body: Buffer.concat(chunks).toString(), headers: request.headers });
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(request.url === "/api/v1/recall"
    ? [{ text: JSON.stringify(record) }] : { status: "completed" }));
});
let first;
let second;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cognee = new CogneeApiClient({ serviceUrl: `http://127.0.0.1:${server.address().port}`, authScheme: "none" });
  first = new WorkgraphOutbox(join(dataDir, "smoke.db"));
  second = new WorkgraphOutbox(first.path);
  const event = first.append({
    workspaceId: workspace, initiativeId: issue, initiativeIdentifier: "WG-1", issueId: issue,
    issueIdentifier: "WG-1", eventType: "decision_recorded", boundedSummary: record.summary,
    source: record.source, authority: record.authority, nodeSets: record.node_sets,
    schemaVersion: SCHEMA_VERSION, extractionPromptVersion: EXTRACTION_PROMPT_VERSION, memoryRecord: record,
  });
  assert.equal(first.claimPending(workspace, "one").length, 1);
  assert.equal(second.claimPending(workspace, "two").length, 0);
  first.releaseClaims("one");
  assert.equal(second.claimPending(workspace, "two").length, 1);
  second.releaseClaims("two");
  first.initializeActivityBaseline(workspace, issue, ["baseline"]);
  assert.equal(second.hasSeenActivity(workspace, issue, "baseline"), true);

  const runtime = new WorkgraphRuntime({ env: {}, outbox: first, cognee });
  const root = { id: issue, workspace_id: workspace, identifier: "WG-1", status: "open", parent_issue_id: null, project_id: null, stage: null };
  runtime.lockInitiative({ workspace: { id: workspace, slug: "smoke", name: "Smoke" }, issue: root, root, chain: [issue] });
  assert.deepEqual(await runtime.flush(), { delivered: 1, failed: 0 });
  assert.equal(second.get(event.eventId).deliveryAttempts, 1);
  assert.equal(second.pendingCount(workspace), 0);
  assert.equal(requests[0].headers["idempotency-key"], event.payloadHash);
  assert.match(requests[0].body, /WORKGRAPH_RECORD_V1/);
  assert.match(requests[0].body, /workgraph-workspace-smoke/);
  assert.equal((await cognee.recall("smoke", "workgraph-workspace-smoke"))[0].text, JSON.stringify(record));

  // Exercise the installed entrypoints, not source imports or a mock runtime.
  process.env.WORKGRAPH_DATA_DIR = dataDir;
  for (const extension of [pi, omp, legacy]) {
    const handlers = new Map();
    const tools = new Map();
    extension({
      on: (name, handler) => handlers.set(name, handler),
      registerTool: (tool) => tools.set(tool.name, tool),
      registerFlag() {}, getFlag() {},
    });
    const ctx = { hasUI: false, ui: { setStatus() {}, notify() {} }, sessionManager: { buildContextEntries: () => [] } };
    await handlers.get("session_start")({}, ctx);
    assert.equal(tools.size, 6);
    assert.equal((await tools.get("initiative_memory_status").execute()).details.value.mode, "no-initiative");
    await handlers.get("session_shutdown")({}, ctx);
  }
  console.log(`Runtime smoke passed (${process.versions.bun ? `Bun ${process.versions.bun}` : process.version})`);
} finally {
  first?.close();
  second?.close();
  server.close();
  await once(server, "close");
  rmSync(dataDir, { recursive: true, force: true });
}
