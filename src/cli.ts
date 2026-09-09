#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { MulticaReader } from "./multica.js";
import { outboxPath } from "./config.js";
import { FollowupStore, reconcileFollowups } from "./followups.js";
import { doctor } from "./doctor.js";

const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
  console.log("Usage: workgraph doctor [--online] [--json]\n       workgraph followups [--dispatch] [--json]\n\nCheck configuration and the data directory without writes.\n--online also verifies the Multica workspace and Cognee health endpoint.\nRun OMP or Pi to use Workgraph memory tools.");
} else if (args.length === 1 && args[0] === "--version") {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  console.log(manifest.version);
} else if (args[0] === "doctor" && args.slice(1).every((arg) => ["--online", "--json"].includes(arg))) {
  try {
    const checks = await doctor(process.env, args.includes("--online"));
    console.log(args.includes("--json") ? JSON.stringify(checks, null, 2)
      : checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`).join("\n"));
    process.exitCode = checks.some((check) => check.status === "error") ? 1 : 0;
  } catch {
    console.error("Workgraph diagnostics failed");
    process.exitCode = 1;
  }
} else if (args[0] === "followups" && args.slice(1).every((arg) => ["--dispatch", "--json"].includes(arg))) {
  let store: FollowupStore | undefined;
  try {
    const workspace = process.env.MULTICA_WORKSPACE_ID?.trim();
    if (!workspace) throw new Error("MULTICA_WORKSPACE_ID is required");
    store = new FollowupStore(`${outboxPath()}.followups.db`);
    const reader = new MulticaReader({ binary: process.env.MULTICA_BIN || "multica", env: process.env });
    const followups = await reconcileFollowups(store, reader, workspace, args.includes("--dispatch"));
    console.log(args.includes("--json") ? JSON.stringify(followups, null, 2)
      : followups.map((item) => `${item.ownerIdentifier} ${item.status}: ${item.observation ?? "waiting"} (${item.reason})`).join("\n"));
    process.exitCode = followups.some((item) => item.status === "dispatching"
      || /read_failed|changed/.test(item.observation ?? "")) ? 1 : 0;
  } catch {
    console.error("Follow-up reconciliation failed; check workspace authentication and the local ledger.");
    process.exitCode = 1;
  } finally { store?.close(); }
} else {
  console.error("Unknown command or option. Run workgraph --help.");
  process.exitCode = 2;
}
