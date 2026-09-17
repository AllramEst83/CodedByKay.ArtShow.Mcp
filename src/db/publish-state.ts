import type { DatabaseSync } from "node:sqlite";
import type { PublishStateRow } from "../lib/types.js";

export function markDirty(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO PublishStates (Id, Dirty) VALUES (1, 1)
     ON CONFLICT(Id) DO UPDATE SET Dirty = 1`,
  ).run();
}

export function markPublished(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO PublishStates (Id, Dirty) VALUES (1, 0)
     ON CONFLICT(Id) DO UPDATE SET Dirty = 0`,
  ).run();
}

export function getPublishState(db: DatabaseSync): { dirty: boolean } {
  const row = db.prepare("SELECT * FROM PublishStates WHERE Id = 1").get() as unknown as PublishStateRow | undefined;
  return { dirty: row ? row.Dirty !== 0 : false };
}

export function setPublishDirty(db: DatabaseSync, dirty: boolean): { dirty: boolean } {
  db.prepare(
    `INSERT INTO PublishStates (Id, Dirty) VALUES (1, @dirty)
     ON CONFLICT(Id) DO UPDATE SET Dirty = @dirty`,
  ).run({ dirty: dirty ? 1 : 0 });
  return { dirty };
}
