import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const DEFAULT_DB_PATH = String.raw`C:\Users\kaywi\dev\CodedByKay.ArtShow.CLI\Db\artwork.db`;

export const DB_PATH = process.env.ARTSHOW_DB_PATH ?? DEFAULT_DB_PATH;

if (!existsSync(DB_PATH)) {
  throw new Error(
    `ArtShow catalog not found at "${DB_PATH}". Set ARTSHOW_DB_PATH to override the location.`,
  );
}

// Read-only: this server never writes. CodedByKay.ArtShow.CLI is the sole writer of the catalog
// (see ArtShow.Workspace/AGENTS.md). The db runs in WAL mode alongside the CLI; a read-only
// connection can safely read committed data while the CLI has it open.
export const db = new DatabaseSync(DB_PATH, { readOnly: true });

export function parseStringList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}
