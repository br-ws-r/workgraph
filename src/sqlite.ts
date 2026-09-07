import { createRequire } from "node:module";

type Row = Record<string, unknown>;
type Parameter = string | number | bigint | null | Record<string, string | number | bigint | null>;

/** The synchronous SQL subset shared by Node and Bun. No ORM or native addon needed. */
export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...parameters: Parameter[]): { changes: number | bigint };
    get(...parameters: Parameter[]): Row | undefined;
    all(...parameters: Parameter[]): Row[];
  };
  close(): void;
}

export function openDatabase(path: string): SqliteDatabase {
  const require = createRequire(import.meta.url);
  if (process.versions.bun) {
    const { Database } = require("bun:sqlite") as {
      Database: new (path: string, options: { strict: boolean; create: boolean }) => SqliteDatabase;
    };
    // Bun strict mode accepts .run({ eventId: ... }) for SQL @eventId placeholders,
    // matching Node's bare binding keys, and rejects missing parameters.
    return new Database(path, { strict: true, create: true });
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  return new DatabaseSync(path);
}
