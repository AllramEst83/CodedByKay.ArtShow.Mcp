import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ArtworkRow, ClassifierKind, ClassifierRow, ClassifierWithUsage, FuzzyMatch } from "../lib/types.js";
import { closestMatch } from "../lib/fuzzy.js";
import { allArtworkRows, parseStringList } from "./artworks.js";
import { markDirty } from "./publish-state.js";

export const CLASSIFIER_KINDS: readonly ClassifierKind[] = ["Category", "Medium", "Tag", "Group"];

/** Mirrors CatalogPicker.EnsureKnownAsync — a classifier value used on an artwork is
 * auto-remembered so it shows up as a pickable choice in the CLI too. */
export function ensureClassifier(db: DatabaseSync, kind: ClassifierKind, name: string): void {
  const exists = db
    .prepare("SELECT 1 FROM Classifiers WHERE Kind = @kind AND Name = @name COLLATE NOCASE")
    .get({ kind, name });
  if (exists) return;
  db.prepare("INSERT INTO Classifiers (Kind, Name) VALUES (@kind, @name)").run({ kind, name });
}

export interface ListClassifiersFilter {
  kind?: ClassifierKind;
  search?: string;
}

export function listClassifierRows(db: DatabaseSync, filter: ListClassifiersFilter): ClassifierRow[] {
  const clauses: string[] = [];
  const params: Record<string, SQLInputValue> = {};

  if (filter.kind !== undefined) {
    clauses.push("Kind = @kind");
    params.kind = filter.kind;
  }
  if (filter.search !== undefined) {
    clauses.push("Name LIKE @search COLLATE NOCASE");
    params.search = `%${filter.search}%`;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM Classifiers ${where} ORDER BY Kind, Name COLLATE NOCASE`)
    .all(params) as unknown as ClassifierRow[];
}

function usageOf(kind: ClassifierKind, name: string, rows: readonly ArtworkRow[]): ArtworkRow[] {
  const needle = name.toLowerCase();
  return rows.filter((a) => {
    if (kind === "Category") return a.Category?.toLowerCase() === needle;
    if (kind === "Medium") return a.Medium?.toLowerCase() === needle;
    if (kind === "Tag") return parseStringList(a.Tags).some((t) => t.toLowerCase() === needle);
    return parseStringList(a.Groups).some((g) => g.toLowerCase() === needle);
  });
}

/**
 * The classification vocabulary an agent should classify against — usage count and example
 * titles included so it's obvious which values are actually established versus a one-off typo
 * nobody would pick again. This is the tool an agent calls before writing category/medium/
 * tags/groups on a new artwork (see AGENTS.md-equivalent guidance in the tool description).
 */
export function listClassifiersWithUsage(db: DatabaseSync, filter: ListClassifiersFilter): ClassifierWithUsage[] {
  const rows = listClassifierRows(db, filter);
  const artworkRows = allArtworkRows(db);
  return rows.map((c) => {
    const kind = c.Kind as ClassifierKind;
    const used = usageOf(kind, c.Name, artworkRows);
    return {
      id: c.Id,
      kind,
      name: c.Name,
      usageCount: used.length,
      exampleTitles: used.slice(0, 3).map((a) => a.Title),
    };
  });
}

/** Fuzzy-matches each candidate string against the existing vocabulary (optionally scoped to one
 * kind) so near-duplicates ("watercolour" vs "watercolor") surface before they become a second
 * classifier. Used by list_classifiers({match}) and by add/update_artworks in "strict" mode. */
export function matchClassifierCandidates(
  db: DatabaseSync,
  candidates: readonly string[],
  kind?: ClassifierKind,
): FuzzyMatch[] {
  const pool = listClassifierRows(db, kind ? { kind } : {});
  return candidates.map((candidate) => {
    const poolForKind = kind ? pool : pool;
    const best = closestMatch(candidate, poolForKind, (c) => c.Name);
    if (!best) return { candidate, bestMatch: null, kind: kind ?? null, exact: false, distance: null };
    return {
      candidate,
      bestMatch: best.name,
      kind: (best.item.Kind as ClassifierKind) ?? kind ?? null,
      exact: best.exact,
      distance: best.distance,
    };
  });
}

export function createClassifier(db: DatabaseSync, kind: ClassifierKind, name: string): ClassifierRow {
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
  merged: boolean;
}

/**
 * Renames a classifier, cascading into every artwork row using it (same as the CLI). New:
 * `merge` — when the target name already exists as a different classifier of the same kind, the
 * default (merge: false) errors; merge: true instead folds the rename into that existing
 * classifier (cascades artworks onto it, then deletes the now-redundant source row) — the actual
 * fix for cleaning up a near-duplicate like "watercolour"/"watercolor" into one value.
 */
export function renameClassifier(
  db: DatabaseSync,
  id: number,
  newName: string,
  merge: boolean,
): RenameClassifierResult {
  const target = db.prepare("SELECT * FROM Classifiers WHERE Id = @id").get({ id }) as unknown as
    | ClassifierRow
    | undefined;
  if (!target) throw new Error(`Classifier ${id} not found.`);

  const dupe = db
    .prepare("SELECT * FROM Classifiers WHERE Kind = @kind AND Id != @id AND Name = @name COLLATE NOCASE")
    .get({ kind: target.Kind, id, name: newName }) as unknown as ClassifierRow | undefined;

  if (dupe && !merge) {
    throw new Error(
      `A ${target.Kind} classifier named "${newName}" already exists (id ${dupe.Id}). ` +
        `Pass merge: true to fold "${target.Name}" into it instead of erroring.`,
    );
  }

  const oldName = target.Name;
  const kind = target.Kind as ClassifierKind;
  const artworks = allArtworkRows(db);

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

  let finalClassifier: ClassifierRow;
  if (dupe && merge) {
    // Fold into the existing target: artworks are already cascaded onto `newName` above, so the
    // source classifier row is now redundant — delete it rather than leaving two rows for one name.
    db.prepare("DELETE FROM Classifiers WHERE Id = @id").run({ id });
    finalClassifier = dupe;
  } else {
    db.prepare("UPDATE Classifiers SET Name = @name WHERE Id = @id").run({ id, name: newName });
    finalClassifier = db.prepare("SELECT * FROM Classifiers WHERE Id = @id").get({ id }) as unknown as ClassifierRow;
  }

  if (touched > 0) markDirty(db);

  return { classifier: finalClassifier, artworksTouched: touched, merged: dupe !== undefined && merge };
}

export interface DeleteClassifierResult {
  deleted: boolean;
  usageCount: number;
  message?: string;
}

export function deleteClassifier(db: DatabaseSync, id: number, force: boolean): DeleteClassifierResult {
  const target = db.prepare("SELECT * FROM Classifiers WHERE Id = @id").get({ id }) as unknown as
    | ClassifierRow
    | undefined;
  if (!target) return { deleted: false, usageCount: 0, message: `Classifier ${id} not found.` };

  const kind = target.Kind as ClassifierKind;
  const name = target.Name;
  const artworks = allArtworkRows(db);
  const used = usageOf(kind, name, artworks);
  const usageCount = used.length;

  if (usageCount > 0 && !force) {
    return {
      deleted: false,
      usageCount,
      message: `"${name}" is used by ${usageCount} artwork(s). Pass force: true to delete it and remove it from them.`,
    };
  }

  if (usageCount > 0) {
    for (const a of used) {
      const updates: Record<string, SQLInputValue> = {};
      if (kind === "Category") updates.Category = null;
      else if (kind === "Medium") updates.Medium = null;
      else if (kind === "Tag") {
        updates.Tags = JSON.stringify(parseStringList(a.Tags).filter((t) => t.toLowerCase() !== name.toLowerCase()));
      } else if (kind === "Group") {
        updates.Groups = JSON.stringify(
          parseStringList(a.Groups).filter((g) => g.toLowerCase() !== name.toLowerCase()),
        );
      }

      const setClauses = Object.keys(updates)
        .map((col) => `${col} = @${col}`)
        .join(", ");
      db.prepare(`UPDATE Artworks SET ${setClauses} WHERE Id = @id`).run({ ...updates, id: a.Id });
    }
    markDirty(db);
  }

  db.prepare("DELETE FROM Classifiers WHERE Id = @id").run({ id });
  return { deleted: true, usageCount };
}
