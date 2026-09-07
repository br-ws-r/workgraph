import type { MulticaActivity } from "./multica.js";
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
