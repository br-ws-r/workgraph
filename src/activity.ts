import type { MulticaActivity, MulticaHandoff } from "./multica.js";
import { boundText } from "./schema.js";

export function summarizeActivity(activity: MulticaActivity, issueIdentifier: string): string {
  const details = activity.details;
  const from = detailValue(details.from);
  const to = detailValue(details.to);
  let change: string;
  switch (activity.action) {
    case "status_changed": change = transition("Status", from, to); break;
    case "priority_changed": change = transition("Priority", from, to); break;
    case "title_changed": change = transition("Title", from, to); break;
    case "start_date_changed": change = transition("Start date", from, to); break;
    case "due_date_changed": change = transition("Due date", from, to); break;
    case "assignee_changed":
      change = transition("Assignee", actorValue(details, "from"), actorValue(details, "to"));
      break;
    case "created": change = "Issue was created."; break;
    case "description_updated": change = "Description was updated."; break;
    case "task_completed": change = "Task completed."; break;
    case "task_failed": change = "Task failed."; break;
    case "squad_leader_evaluated": {
      const outcome = detailValue(details.outcome);
      change = outcome ? `Squad leader evaluation recorded outcome ${outcome}.` : "Squad leader evaluation was recorded.";
      break;
    }
    default: change = `Multica recorded activity ${boundText(activity.action, 128)}.`;
  }
  const actor = activity.actor_type
    ? ` Actor type: ${boundText(activity.actor_type, 128)}.`
    : "";
  return `Multica issue ${issueIdentifier}: ${change}${actor}`;
}

function transition(label: string, from: string | undefined, to: string | undefined): string {
  return `${label} changed from ${from ?? "(none)"} to ${to ?? "(none)"}.`;
}

function actorValue(details: Record<string, unknown>, prefix: "from" | "to"): string | undefined {
  return detailValue(details[`${prefix}_type`]);
}

function detailValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? boundText(String(value), 300)
    : undefined;
}

/** Retain a bounded authored handoff excerpt, never infer an outcome from status. */
export function summarizeHandoff(comment: MulticaHandoff): string | undefined {
  if (comment.actor_type !== "agent" || !comment.source_task_id) return undefined;
  // The standard handoff contract starts with a state and a short narrative.
  // Full attachments, fenced logs, transcripts and arbitrary comments are not ingested.
  const paragraph = comment.content.trim().split(/\n\s*\n|```/)[0].trim();
  if (!/^(?:DONE|BLOCKED|IN PROGRESS)\.\s+\S/.test(paragraph) || paragraph.length < 50) return undefined;
  if (/-----BEGIN|Bearer\s+|gh[pousr]_|github_pat_|sk-[A-Za-z0-9]{24}|(?:password|api[_-]?key|token)\s*[=:]/i.test(paragraph)) return undefined;
  return boundText(paragraph.replace(/\[([^\]]+)\]\(mention:\/\/[^)]+\)/g, "$1"), 1800);
}
