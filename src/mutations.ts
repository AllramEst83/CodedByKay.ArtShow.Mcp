import type { SQLInputValue } from "node:sqlite";
import { db, parseStringList, todayIsoDate } from "./db.js";
import { toDto } from "./queries.js";
import type { ArtworkDto, ArtworkRow, ClassifierRow } from "./types.js";

// DB-only CRUD: this module mutates artwork.db directly and never touches R2. Deleting/replacing
// an artwork's R2 objects (originals/thumbnails) stays with CodedByKay.ArtShow.CLI's own
// "Delete artwork" flow, which has the R2 credentials and client already wired up.
const CLASSIFIER_KINDS = ["Category", "Medium", "Tag", "Group"] as const;
export type ClassifierKind = (typeof CLASSIFIER_KINDS)[number];

function markDirty(): void {
  db.prepare(
    `INSERT INTO PublishStates (Id, Dirty) VALUES (1, 1)
     ON CONFLICT(Id) DO UPDATE SET Dirty = 1`,
  ).run();
}

// Mirrors CatalogPicker.EnsureKnownAsync — a classifier value used on an artwork is
// auto-remembered so it shows up as a pickable choice in the CLI too.
function ensureClassifier(kind: ClassifierKind, name: string): void {
  const exists = db
    .prepare("SELECT 1 FROM Classifiers WHERE Kind = @kind AND Name = @name COLLATE NOCASE")
    .get({ kind, name });
  if (exists) return;
  db.prepare("INSERT INTO Classifiers (Kind, Name) VALUES (@kind, @name)").run({ kind, name });
}

function fetchArtworkRow(id: number): ArtworkRow | undefined {
  return db.prepare("SELECT * FROM Artworks WHERE Id = @id").get({ id }) as unknown as ArtworkRow | undefined;
}

export interface CreateArtworkInput {
  title: string;
  type?: "image" | "video";
  addedDate?: string;
  description?: string;
  createdDate?: string;
  category?: string;
  medium?: string;
  tags?: string[];
  groups?: string[];
  r2Key?: string;
  thumbR2Key?: string;
  videoId?: string;
  originalPath?: string;
}

export function createArtwork(input: CreateArtworkInput): ArtworkDto {
  const isVideo = input.type === "video";
  if (isVideo && !input.videoId) {
    throw new Error("videoId is required when type is 'video'.");
  }

  const tags = input.tags ?? [];
  const groups = input.groups ?? [];
  if (input.category) ensureClassifier("Category", input.category);
  if (input.medium) ensureClassifier("Medium", input.medium);
  for (const tag of tags) ensureClassifier("Tag", tag);
  for (const group of groups) ensureClassifier("Group", group);

  const originalPath = input.originalPath ?? (isVideo ? `youtube:${input.videoId}` : "");

  const params: Record<string, SQLInputValue> = {
    type: isVideo ? "video" : null,
    addedDate: input.addedDate ?? todayIsoDate(),
    title: input.title,
    description: input.description ?? null,
    createdDate: input.createdDate ?? null,
    category: input.category ?? null,
    medium: input.medium ?? null,
    originalPath,
    r2Key: isVideo ? null : (input.r2Key ?? null),
    thumbR2Key: isVideo ? null : (input.thumbR2Key ?? null),
    videoId: isVideo ? input.videoId! : null,
    tags: JSON.stringify(tags),
    groups: JSON.stringify(groups),
  };

  const result = db
    .prepare(
      `INSERT INTO Artworks
        (Type, AddedDate, Title, Description, CreatedDate, Category, Medium, OriginalPath, R2Key, ThumbR2Key, VideoId, Tags, Groups)
       VALUES
        (@type, @addedDate, @title, @description, @createdDate, @category, @medium, @originalPath, @r2Key, @thumbR2Key, @videoId, @tags, @groups)`,
    )
    .run(params);

  markDirty();
  const row = fetchArtworkRow(Number(result.lastInsertRowid))!;
  return toDto(row);
}

export interface UpdateArtworkInput {
  title?: string;
  type?: "image" | "video";
  addedDate?: string;
  description?: string | null;
  createdDate?: string | null;
  category?: string | null;
  medium?: string | null;
  tags?: string[];
  groups?: string[];
  r2Key?: string | null;
  thumbR2Key?: string | null;
  videoId?: string | null;
  originalPath?: string;
}

const UPDATE_COLUMN_BY_KEY: Record<keyof UpdateArtworkInput, string> = {
  title: "Title",
  type: "Type",
  addedDate: "AddedDate",
  description: "Description",
  createdDate: "CreatedDate",
  category: "Category",
  medium: "Medium",
  tags: "Tags",
  groups: "Groups",
  r2Key: "R2Key",
  thumbR2Key: "ThumbR2Key",
  videoId: "VideoId",
  originalPath: "OriginalPath",
};

export function updateArtwork(id: number, patch: UpdateArtworkInput): ArtworkDto | null {
  const existing = fetchArtworkRow(id);
  if (!existing) return null;

  if (patch.category) ensureClassifier("Category", patch.category);
  if (patch.medium) ensureClassifier("Medium", patch.medium);
  for (const tag of patch.tags ?? []) ensureClassifier("Tag", tag);
  for (const group of patch.groups ?? []) ensureClassifier("Group", group);

  const setClauses: string[] = [];
  const params: Record<string, SQLInputValue> = { id };

  for (const key of Object.keys(patch) as (keyof UpdateArtworkInput)[]) {
    const column = UPDATE_COLUMN_BY_KEY[key];
    let value: SQLInputValue;
    if (key === "type") {
      value = patch.type === "video" ? "video" : null;
    } else if (key === "tags" || key === "groups") {
      value = JSON.stringify(patch[key]);
    } else {
      value = (patch[key] as string | null | undefined) ?? null;
    }
    setClauses.push(`${column} = @${key}`);
    params[key] = value;
  }

  if (setClauses.length === 0) return toDto(existing);

  db.prepare(`UPDATE Artworks SET ${setClauses.join(", ")} WHERE Id = @id`).run(params);
  markDirty();
  return toDto(fetchArtworkRow(id)!);
}

export function deleteArtwork(id: number): boolean {
  const existing = fetchArtworkRow(id);
  if (!existing) return false;

  db.prepare("DELETE FROM Artworks WHERE Id = @id").run({ id });
  markDirty();
  return true;
}

export function createClassifier(kind: ClassifierKind, name: string): ClassifierRow {
  const dupe = db
    .prepare("SELECT 1 FROM Classifiers WHERE Kind = @kind AND Name = @name COLLATE NOCASE")
    .get({ kind, name });
  if (dupe) throw new Error(`A ${kind} classifier named "${name}" already exists.`);

  const result = db.prepare("INSERT INTO Classifiers (Kind, Name) VALUES (@kind, @name)").run({ kind, name });
  return db
    .prepare("SELECT * FROM Classifiers WHERE Id = @id")
    .get({ id: Number(result.lastInsertRowid) }) as unknown as ClassifierRow;
}

// Renaming can collide with a value already present elsewhere in the same list (e.g. renaming
// "sketch" to "pencil" on an artwork that already has both) — dedup after the swap, mirroring
// ManageClassifiersFlow.Renamed in the CLI.
function renamedList(values: string[], oldName: string, newName: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of values) {
    const next = v.toLowerCase() === oldName.toLowerCase() ? newName : v;
    const key = next.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(next);
    }
  }
  return result;
}

export interface RenameClassifierResult {
  classifier: ClassifierRow;
  artworksTouched: number;
}

export function renameClassifier(id: number, newName: string): RenameClassifierResult {
  const target = db.prepare("SELECT * FROM Classifiers WHERE Id = @id").get({ id }) as unknown as
    | ClassifierRow
    | undefined;
  if (!target) throw new Error(`Classifier ${id} not found.`);

  const dupe = db
    .prepare("SELECT 1 FROM Classifiers WHERE Kind = @kind AND Id != @id AND Name = @name COLLATE NOCASE")
    .get({ kind: target.Kind, id, name: newName });
  if (dupe) throw new Error(`A ${target.Kind} classifier named "${newName}" already exists.`);

  const oldName = target.Name;
  const kind = target.Kind as ClassifierKind;
  const artworks = db.prepare("SELECT * FROM Artworks").all() as unknown as ArtworkRow[];

  let touched = 0;
  for (const a of artworks) {
    const updates: Record<string, SQLInputValue> = {};
    if (kind === "Category" && a.Category?.toLowerCase() === oldName.toLowerCase()) {
      updates.Category = newName;
    } else if (kind === "Medium" && a.Medium?.toLowerCase() === oldName.toLowerCase()) {
      updates.Medium = newName;
    } else if (kind === "Tag") {
      const tags = parseStringList(a.Tags);
      if (tags.some((t) => t.toLowerCase() === oldName.toLowerCase())) {
        updates.Tags = JSON.stringify(renamedList(tags, oldName, newName));
      }
    } else if (kind === "Group") {
      const groups = parseStringList(a.Groups);
      if (groups.some((g) => g.toLowerCase() === oldName.toLowerCase())) {
        updates.Groups = JSON.stringify(renamedList(groups, oldName, newName));
      }
    }

    if (Object.keys(updates).length > 0) {
      const setClauses = Object.keys(updates)
        .map((col) => `${col} = @${col}`)
        .join(", ");
      db.prepare(`UPDATE Artworks SET ${setClauses} WHERE Id = @id`).run({ ...updates, id: a.Id });
      touched++;
    }
  }

  db.prepare("UPDATE Classifiers SET Name = @name WHERE Id = @id").run({ id, name: newName });
  if (touched > 0) markDirty();

  const updated = db.prepare("SELECT * FROM Classifiers WHERE Id = @id").get({ id }) as unknown as ClassifierRow;
  return { classifier: updated, artworksTouched: touched };
}

export interface DeleteClassifierResult {
  deleted: boolean;
  usageCount: number;
  message?: string;
}

export function deleteClassifier(id: number, force: boolean): DeleteClassifierResult {
  const target = db.prepare("SELECT * FROM Classifiers WHERE Id = @id").get({ id }) as unknown as
    | ClassifierRow
    | undefined;
  if (!target) return { deleted: false, usageCount: 0, message: `Classifier ${id} not found.` };

  const kind = target.Kind as ClassifierKind;
  const name = target.Name;
  const artworks = db.prepare("SELECT * FROM Artworks").all() as unknown as ArtworkRow[];

  const usageCount = artworks.filter((a) => {
    if (kind === "Category") return a.Category?.toLowerCase() === name.toLowerCase();
    if (kind === "Medium") return a.Medium?.toLowerCase() === name.toLowerCase();
    if (kind === "Tag") return parseStringList(a.Tags).some((t) => t.toLowerCase() === name.toLowerCase());
    return parseStringList(a.Groups).some((g) => g.toLowerCase() === name.toLowerCase());
  }).length;

  if (usageCount > 0 && !force) {
    return {
      deleted: false,
      usageCount,
      message: `"${name}" is used by ${usageCount} artwork(s). Pass force: true to delete it and remove it from them.`,
    };
  }

  if (usageCount > 0) {
    for (const a of artworks) {
      const updates: Record<string, SQLInputValue> = {};
      if (kind === "Category" && a.Category?.toLowerCase() === name.toLowerCase()) updates.Category = null;
      else if (kind === "Medium" && a.Medium?.toLowerCase() === name.toLowerCase()) updates.Medium = null;
      else if (kind === "Tag") {
        const tags = parseStringList(a.Tags);
        if (tags.some((t) => t.toLowerCase() === name.toLowerCase())) {
          updates.Tags = JSON.stringify(tags.filter((t) => t.toLowerCase() !== name.toLowerCase()));
        }
      } else if (kind === "Group") {
        const groups = parseStringList(a.Groups);
        if (groups.some((g) => g.toLowerCase() === name.toLowerCase())) {
          updates.Groups = JSON.stringify(groups.filter((g) => g.toLowerCase() !== name.toLowerCase()));
        }
      }

      if (Object.keys(updates).length > 0) {
        const setClauses = Object.keys(updates)
          .map((col) => `${col} = @${col}`)
          .join(", ");
        db.prepare(`UPDATE Artworks SET ${setClauses} WHERE Id = @id`).run({ ...updates, id: a.Id });
      }
    }
    markDirty();
  }

  db.prepare("DELETE FROM Classifiers WHERE Id = @id").run({ id });
  return { deleted: true, usageCount };
}

export function setPublishDirty(dirty: boolean): { dirty: boolean } {
  db.prepare(
    `INSERT INTO PublishStates (Id, Dirty) VALUES (1, @dirty)
     ON CONFLICT(Id) DO UPDATE SET Dirty = @dirty`,
  ).run({ dirty: dirty ? 1 : 0 });
  return { dirty };
}
