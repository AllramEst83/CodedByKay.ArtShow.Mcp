import type { DatabaseSync } from "node:sqlite";

// This server never runs EF Core migrations and never creates tables — that stays
// CodedByKay.ArtShow.CLI's job (Program.cs calls db.Database.MigrateAsync() at startup). A
// missing table/column here means "the CLI hasn't been run yet on this db" or "the CLI's schema
// moved and this server's assumptions are stale" — either way, failing loud and early beats a
// cryptic SQLITE_ERROR from the first query a tool call makes.
const REQUIRED_COLUMNS: Record<string, string[]> = {
  Artworks: [
    "Id",
    "AddedDate",
    "Title",
    "Description",
    "CreatedDate",
    "Category",
    "Medium",
    "Type",
    "OriginalPath",
    "R2Key",
    "ThumbR2Key",
    "VideoId",
    "Tags",
    "Groups",
  ],
  Classifiers: ["Id", "Kind", "Name"],
  PublishStates: ["Id", "Dirty"],
};

interface TableInfoRow {
  name: string;
}

export function assertSchema(db: DatabaseSync): void {
  const problems: string[] = [];

  for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = @table")
      .get({ table });
    if (!exists) {
      problems.push(`table "${table}" is missing`);
      continue;
    }

    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableInfoRow[]).map((c) => c.name),
    );
    const missingColumns = requiredColumns.filter((c) => !columns.has(c));
    if (missingColumns.length > 0) {
      problems.push(`table "${table}" is missing column(s): ${missingColumns.join(", ")}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `artwork.db schema doesn't match what this server expects:\n  - ${problems.join("\n  - ")}\n` +
        `Run CodedByKay.ArtShow.CLI once (it applies EF Core migrations) and try again. If the CLI's ` +
        `schema changed on purpose, src/schema-guard.ts and the query/mutation layer here need updating too.`,
    );
  }
}
