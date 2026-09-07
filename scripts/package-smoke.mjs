import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const consumer = mkdtempSync(join(tmpdir(), "workgraph-package-"));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(COGNEE_|MULTICA_|WORKGRAPH_)/.test(key)) delete env[key];
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (command, args) => execFileSync(command, args, { cwd: consumer, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
try {
  // Build occurs before this script; ignore lifecycle scripts to pack those exact artifacts.
  const [packed] = JSON.parse(run(npm, ["pack", root, "--ignore-scripts", "--json", "--pack-destination", consumer]));
  assert(packed.files.some((file) => file.path === "dist/src/cli.js"));
  assert(packed.files.every((file) => /^(dist\/|docs\/|README.md$|LICENSE$|CHANGELOG.md$|package.json$|\.env\.example$)/.test(file.path)), "Unexpected package contents");
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const fromGit = process.argv.includes("--git");
  const revision = fromGit ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() : undefined;
  const source = fromGit ? `git+${pathToFileURL(root).href}#${revision}` : join(consumer, packed.filename);
  run(npm, ["install", "--omit=dev", ...(fromGit ? [] : ["--ignore-scripts"]), "--no-audit", "--no-fund", source]);
  const installed = join(consumer, "node_modules/@br-ws-r/workgraph");
  assert(!existsSync(join(consumer, "node_modules/@earendil-works/pi-ai")));
  assert(!existsSync(join(consumer, "node_modules/@earendil-works/pi-coding-agent")));
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(run(process.execPath, [join(installed, manifest.bin.workgraph), "--version"]).trim(), manifest.version);
  const checks = JSON.parse(run(npm, ["exec", "--offline", "--", "workgraph", "doctor", "--json"]));
  assert(checks.some((check) => check.name === "cognee-config" && check.status === "warning"));
  copyFileSync(join(root, "scripts/runtime-smoke.mjs"), join(consumer, "runtime-smoke.mjs"));
  console.log(run(process.execPath, ["runtime-smoke.mjs"]).trim());
  if (process.argv.includes("--bun")) console.log(run("bun", ["runtime-smoke.mjs"]).trim());
  console.log(`Package smoke passed (${fromGit ? "Git prepare" : "tarball"}): ${packed.files.length} files, ${packed.size} bytes, no Pi runtime dependencies`);
} catch (error) {
  if (error.stderr) console.error(String(error.stderr));
  throw error;
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
