#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { doctor } from "./doctor.js";

const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
  console.log("Usage: workgraph doctor [--online] [--json]\n\nCheck configuration and the data directory without writes.\n--online also verifies the Multica workspace and Cognee health endpoint.\nRun OMP or Pi to use Workgraph memory tools.");
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
} else {
  console.error("Unknown command or option. Run workgraph --help.");
  process.exitCode = 2;
}
