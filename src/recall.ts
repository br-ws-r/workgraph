import type { CogneeApiClient, CogneeRecallEntry, CogneeRecallOptions } from "./cognee.js";
import { MemoryRecordSchema, type MemoryRecord } from "./schema.js";
import type { RecalledMemory } from "./runtime.js";

function normalizeMemories(entries: CogneeRecallEntry[]): RecalledMemory[] {
  const memories: RecalledMemory[] = [];
  for (const entry of entries) {
    const record = parseMemoryRecord(entry.text);
    if (!record) continue;
    memories.push({
      workspaceId: record.workspace_id,
      initiativeId: record.initiative_id,
      initiativeIdentifier: record.initiative_identifier,
      entityType: record.entity_type,
      entityIdentifier: record.entity_identifier,
      entityLabel: record.entity_label,
      authority: record.authority,
      summary: record.summary,
      source: record.source,
      sourceRevision: record.source_revision,
      observedAt: record.observed_at,
    });
  }
  return memories;
}

export async function recallValidMemories(
  cognee: CogneeApiClient,
  query: string,
  dataset: string,
  options: CogneeRecallOptions,
  onStats?: (stats: { received: number; valid: number; retried: boolean }) => void,
): Promise<RecalledMemory[]> {
  let entries = await cognee.recall(query, dataset, options);
  let memories = normalizeMemories(entries);
  let retried = false;
  if (entries.length > 0 && memories.length === 0) {
    retried = true;
    entries = await cognee.recall(query, dataset, options);
    memories = normalizeMemories(entries);
    if (memories.length === 0) {
      onStats?.({ received: entries.length, valid: 0, retried });
      throw new Error("Cognee Recall returned no valid Workgraph records after one retry");
    }
  }
  onStats?.({ received: entries.length, valid: memories.length, retried });
  return memories;
}

function parseMemoryRecord(text: string): MemoryRecord | undefined {
  const marker = "WORKGRAPH_RECORD_V1";
  const payload = text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : text;
  const trimmed = payload.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = MemoryRecordSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
