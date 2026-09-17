import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../config.js";
import { writeArtworkJsonText } from "../publishing/artwork-json.js";
import { diffArtworkJson } from "../publishing/diff.js";
import type { ArtworkRow } from "../lib/types.js";

// Compares a fresh regeneration from the live DB against the live site artwork.json. Kay uses the
// CLI interactively, so the DB can legitimately be ahead of the last publish (added/removed ids)
// at any moment this runs — that's not a bug. What WOULD be a bug: a row present in both sides
// coming out with different field values, since nothing here should be touching field derivation.
// (Encoder byte-fidelity itself is covered independently by dotnet-json-encoder.test.ts's pure
// parse+re-encode round trip, which doesn't depend on the DB at all.) Read-only: never touches
// the live DB or the site repo.
test("regenerating artwork.json from the live catalog only differs from the last publish by rows added/removed since then", () => {
  const config = loadConfig();
  if (!existsSync(config.dbPath) || !existsSync(config.siteArtworkJsonPath)) {
    console.error(
      `skipping: live db (${config.dbPath}) or site artwork.json (${config.siteArtworkJsonPath}) not found on this machine`,
    );
    return;
  }

  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const rows = db.prepare("SELECT * FROM Artworks").all() as unknown as ArtworkRow[];
  db.close();

  const regenerated = writeArtworkJsonText(rows, config.r2.publicBaseUrl);
  const onDisk = readFileSync(config.siteArtworkJsonPath, "utf8");

  const diff = diffArtworkJson(JSON.parse(onDisk), JSON.parse(regenerated));
  console.error(
    `diff vs last publish: +${diff.added.length} -${diff.removed.length} ~${diff.modified.length} ` +
      `(=${diff.unchangedCount} unchanged) — added/removed are expected while the catalog is ahead ` +
      `of the last publish; ~modified would indicate a real field-derivation mismatch`,
  );
  if (diff.modified.length > 0) {
    console.error(JSON.stringify(diff.modified, null, 2));
  }

  assert.deepEqual(diff.modified, []);
});
