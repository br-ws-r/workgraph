import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cogneeBaseUrl, readCogneeConfig } from "../src/config.js";
import { doctor } from "../src/doctor.js";

describe("portable configuration", () => {
  it("distinguishes absent Cognee from invalid credentials or authentication", () => {
    expect(readCogneeConfig({})).toBeUndefined();
    expect(() => readCogneeConfig({ COGNEE_SERVICE_URL: "https://cognee.test" })).toThrow("COGNEE_API_KEY");
    expect(() => readCogneeConfig({ COGNEE_SERVICE_URL: "https://cognee.test", COGNEE_AUTH_SCHEME: "baerer" })).toThrow("COGNEE_AUTH_SCHEME");
  });

  it.each(["invalid", "99", "100.5", "Infinity", "2147483648"])("rejects invalid timeout %s", (value) => {
    expect(() => readCogneeConfig({
      COGNEE_SERVICE_URL: "https://cognee.test", COGNEE_AUTH_SCHEME: "none", WORKGRAPH_COGNEE_TIMEOUT_MS: value,
    })).toThrow("WORKGRAPH_COGNEE_TIMEOUT_MS");
  });

  it.each(["bad-url", "file:///tmp/cognee", "https://user:secret@cognee.test", "https://cognee.test/?key=secret", "https://cognee.test/#secret", "https://cognee.test/api/v1/"])("rejects unsafe or ambiguous base URL %s", (url) => {
    expect(() => cogneeBaseUrl(url)).toThrow("COGNEE_SERVICE_URL");
  });

  it("preserves a reverse proxy prefix and treats blank optional timeouts as defaults", () => {
    expect(readCogneeConfig({
      COGNEE_SERVICE_URL: " https://example.test/cognee/ ", COGNEE_AUTH_SCHEME: "none",
      WORKGRAPH_COGNEE_TIMEOUT_MS: " ", WORKGRAPH_COGNEE_REMEMBER_TIMEOUT_MS: " ",
    })).toMatchObject({ serviceUrl: "https://example.test/cognee/", timeoutMs: 3000, rememberTimeoutMs: 120000 });
  });

  it("diagnoses without creating data or exposing credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "workgraph-doctor-"));
    const path = join(dir, "uncreated");
    try {
      const checks = await doctor({
        WORKGRAPH_DATA_DIR: path, COGNEE_SERVICE_URL: "https://cognee.test", COGNEE_API_KEY: "never-print-this",
      });
      expect(checks).toContainEqual(expect.objectContaining({ name: "outbox-directory", status: "warning" }));
      expect(JSON.stringify(checks)).not.toContain("never-print-this");
      expect(existsSync(path)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
