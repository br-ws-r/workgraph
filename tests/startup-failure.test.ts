import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkgraphHostExtension } from "../src/extension.js";
import { WorkgraphRuntime } from "../src/runtime.js";

type Handler = (event: any, context: any) => any;
function hostApi() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, any>();
  const pi = {
    registerFlag: vi.fn(),
    registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools };
}

describe.each(["pi", "omp"] as const)("%s startup isolation", (host) => {
  it.each(["x-api-key", "bearer"])("keeps the host usable without %s credentials", async (scheme) => {
    const directory = mkdtempSync(join(tmpdir(), "workgraph-startup-"));
    const env = {
      COGNEE_SERVICE_URL: "http://127.0.0.1:8000", COGNEE_AUTH_SCHEME: scheme,
      WORKGRAPH_DATA_DIR: directory, MULTICA_TASK_ID: "managed-task", MULTICA_AGENT_ID: "managed-agent",
    };
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      // Core callers still receive the strict error; no unauthenticated retry.
      expect(() => new WorkgraphRuntime({ env })).toThrow("COGNEE_API_KEY is required");
      const { pi, handlers, tools } = hostApi();
      expect(() => createWorkgraphHostExtension(host, { env })(pi)).not.toThrow();
      expect(pi.registerFlag).toHaveBeenCalledWith("initiative", expect.anything());
      expect([...tools.keys()]).toEqual(["initiative_memory_status"]);
      const status = await tools.get("initiative_memory_status").execute();
      expect(JSON.stringify(status)).toContain("cognee_credentials_missing");
      expect(JSON.stringify(status)).toContain('"pending_deliveries":null');
      const ui = { setStatus: vi.fn(), notify: vi.fn() };
      await handlers.get("session_start")!({}, { hasUI: true, ui });
      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("credentials are missing"), "warning");
      const systemPrompt = host === "omp" ? ["base"] : "base";
      const prompt = await handlers.get("before_agent_start")!({ systemPrompt }, {});
      expect(Array.isArray(prompt.systemPrompt)).toBe(host === "omp");
      expect(JSON.stringify(prompt)).toContain("recall and writes are disabled");
      await handlers.get("session_shutdown")!({}, { hasUI: true, ui });
      expect(ui.setStatus).toHaveBeenLastCalledWith("workgraph", undefined);
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(join(directory, "workgraph-workspace-v3.db"))).toBe(false);
    } finally {
      fetch.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports startup failure in headless runs without leaking the exception", async () => {
    const { pi, handlers, tools } = hostApi();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      createWorkgraphHostExtension(host, {
        env: {}, runtimeFactory: () => { throw new Error("secret-value-from-driver"); },
      })(pi);
      await handlers.get("session_start")!({}, { hasUI: false });
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("runtime initialization failed"));
      const status = await tools.get("initiative_memory_status").execute();
      const prompt = await handlers.get("before_agent_start")!({ systemPrompt: "base" }, {});
      expect(JSON.stringify([stderr.mock.calls, status, prompt])).not.toContain("secret-value-from-driver");
      await handlers.get("session_shutdown")!({}, { hasUI: false });
    } finally { stderr.mockRestore(); }
  });
});
