import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const DEFAULT_DB_PATH = String.raw`C:\Users\kaywi\dev\CodedByKay.ArtShow.CLI\Db\artwork.db`;

export const DB_PATH = process.env.ARTSHOW_DB_PATH ?? DEFAULT_DB_PATH;

if (!existsSync(DB_PATH)) {
  throw new Error(
    `ArtShow catalog not found at "${DB_PATH}". Set ARTSHOW_DB_PATH to override the location.`,
  );
}

// Read-write: CodedByKay.ArtShow.CLI (EF Core / Microsoft.Data.Sqlite) is usually the only writer,
// but this server can now mutate the catalog too (see mutations.ts) so agents can manage it without
// the interactive TUI. The db runs in WAL mode, which allows one writer + many readers across
// processes via SQLite's normal file locking; busy_timeout below makes a write here wait out a
// momentary lock from the CLI instead of failing immediately with SQLITE_BUSY.
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 5000;");

export function parseStringList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
