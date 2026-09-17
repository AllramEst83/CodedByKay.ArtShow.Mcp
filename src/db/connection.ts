import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { ResolvedConfig } from "../config.js";

let dbInstance: DatabaseSync | undefined;
let dbPathInUse: string | undefined;

// Read-write: CodedByKay.ArtShow.CLI (EF Core / Microsoft.Data.Sqlite) is usually running
// alongside this server, but this server mutates the catalog too (see tools/artworks.ts etc) so
// agents can manage it without the interactive TUI. The db runs in WAL mode, which allows one
// writer + many readers across processes via SQLite's normal file locking; busy_timeout below
// makes a write here wait out a momentary lock from the CLI instead of failing immediately with
// SQLITE_BUSY.
export function openDb(config: ResolvedConfig): DatabaseSync {
  if (dbInstance) return dbInstance;

  if (!existsSync(config.dbPath)) {
    throw new Error(
      `ArtShow catalog not found at "${config.dbPath}". Run CodedByKay.ArtShow.CLI once first ` +
        `(it applies EF Core migrations and creates the file), or set ARTSHOW_DB_PATH to the ` +
        `right location.`,
    );
  }

  dbInstance = new DatabaseSync(config.dbPath);
  dbInstance.exec("PRAGMA busy_timeout = 5000;");
  dbInstance.exec("PRAGMA foreign_keys = ON;");
  dbPathInUse = config.dbPath;
  return dbInstance;
}

export function currentDbPath(): string | undefined {
  return dbPathInUse;
}

/**
 * Runs `fn` inside a SAVEPOINT so it either fully applies or fully rolls back. Used per-item in
 * every batch tool (add/update/delete artworks) so one bad item in a batch can't corrupt the
 * catalog or leave a half-written row — every other item in the same batch still succeeds or
 * fails independently. Named savepoints (not BEGIN/COMMIT) because they nest safely if a caller
 * is itself inside a transaction.
 */
let savepointCounter = 0;

export function withSavepoint<T>(db: DatabaseSync, fn: () => T): T {
  const name = `sp_${++savepointCounter}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw err;
  }
}
