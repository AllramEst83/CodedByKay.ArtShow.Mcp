import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ArtworkDto, ArtworkRow, ClassifierKind } from "../lib/types.js";
import { todayIsoDate } from "../lib/dates.js";
import { ensureClassifier } from "./classifiers.js";
import { markDirty } from "./publish-state.js";

export function parseStringList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function toDto(row: ArtworkRow, r2PublicBaseUrl: string): ArtworkDto {
  const isVideo = row.Type === "video";
  return {
    id: row.Id,
    type: isVideo ? "video" : "image",
    addedDate: row.AddedDate,
    title: row.Title,
    description: row.Description,
    createdDate: row.CreatedDate,
    category: row.Category,
    medium: row.Medium,
    tags: parseStringList(row.Tags),
    groups: parseStringList(row.Groups),
    r2Key: row.R2Key,
    thumbR2Key: row.ThumbR2Key,
    videoId: row.VideoId,
    originalPath: row.OriginalPath,
    imageUrl: !isVideo && row.R2Key ? `${r2PublicBaseUrl}/${row.R2Key}` : null,
    videoUrl: isVideo && row.VideoId ? `https://www.youtube-nocookie.com/embed/${row.VideoId}` : null,
    thumbnailUrl: isVideo
      ? row.VideoId
        ? `https://img.youtube.com/vi/${row.VideoId}/hqdefault.jpg`
        : null
      : row.ThumbR2Key
        ? `${r2PublicBaseUrl}/${row.ThumbR2Key}`
        : null,
  };
}

export interface ListArtworksFilter {
  ids?: number[];
  type?: "image" | "video";
  category?: string;
  medium?: string;
  tag?: string;
  group?: string;
  search?: string;
  addedAfter?: string;
  addedBefore?: string;
  missingR2Key?: boolean;
  orderBy?: "id" | "addedDate" | "title";
  orderDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface ListArtworksResult {
  total: number;
  items: ArtworkDto[];
}

export function listArtworkRows(db: DatabaseSync, filter: ListArtworksFilter): ArtworkRow[] {
  const clauses: string[] = [];
  const params: Record<string, SQLInputValue> = {};

  if (filter.ids !== undefined && filter.ids.length > 0) {
    const placeholders = filter.ids.map((_, i) => `@id${i}`).join(", ");
    clauses.push(`Id IN (${placeholders})`);
    filter.ids.forEach((id, i) => {
      params[`id${i}`] = id;
    });
  }
  if (filter.type !== undefined) {
    clauses.push(filter.type === "video" ? "Type = 'video'" : "(Type IS NULL OR Type != 'video')");
  }
  if (filter.category !== undefined) {
    clauses.push("Category = @category COLLATE NOCASE");
    params.category = filter.category;
  }
  if (filter.medium !== undefined) {
    clauses.push("Medium = @medium COLLATE NOCASE");
    params.medium = filter.medium;
  }
  if (filter.search !== undefined) {
    clauses.push("(Title LIKE @search COLLATE NOCASE OR Description LIKE @search COLLATE NOCASE)");
    params.search = `%${filter.search}%`;
  }
  if (filter.addedAfter !== undefined) {
    clauses.push("AddedDate >= @addedAfter");
    params.addedAfter = filter.addedAfter;
  }
  if (filter.addedBefore !== undefined) {
    clauses.push("AddedDate <= @addedBefore");
    params.addedBefore = filter.addedBefore;
  }
  if (filter.missingR2Key) {
    // Images only — video rows legitimately have no R2Key.
    clauses.push("(Type IS NULL OR Type != 'video') AND R2Key IS NULL");
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM Artworks ${where}`).all(params) as unknown as ArtworkRow[];
}

export function listArtworks(db: DatabaseSync, r2PublicBaseUrl: string, filter: ListArtworksFilter): ListArtworksResult {
  const rows = listArtworkRows(db, filter);

  // Tags/Groups are stored as JSON text, and matching a single value inside that array is
  // awkward and injection-prone in raw SQL LIKE — filter in JS instead. The catalog is small
  // (tens/hundreds of rows), so a full scan here is cheap.
  let dtos = rows.map((r) => toDto(r, r2PublicBaseUrl));
  if (filter.tag !== undefined) {
    const needle = filter.tag.toLowerCase();
    dtos = dtos.filter((a) => a.tags.some((t) => t.toLowerCase() === needle));
  }
  if (filter.group !== undefined) {
    const needle = filter.group.toLowerCase();
    dtos = dtos.filter((a) => a.groups.some((g) => g.toLowerCase() === needle));
  }

  const orderBy = filter.orderBy ?? "id";
  const orderDir = filter.orderDir ?? "asc";
  const dir = orderDir === "desc" ? -1 : 1;
  dtos.sort((a, b) => {
    let cmp: number;
    if (orderBy === "addedDate") cmp = a.addedDate.localeCompare(b.addedDate);
    else if (orderBy === "title") cmp = a.title.localeCompare(b.title);
    else cmp = a.id - b.id;
    return cmp * dir;
  });

  const total = dtos.length;
  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? 50;
  const items = dtos.slice(offset, offset + limit);

  return { total, items };
}

export function fetchArtworkRow(db: DatabaseSync, id: number): ArtworkRow | undefined {
  return db.prepare("SELECT * FROM Artworks WHERE Id = @id").get({ id }) as unknown as ArtworkRow | undefined;
}

export function getArtwork(db: DatabaseSync, r2PublicBaseUrl: string, id: number): ArtworkDto | null {
  const row = fetchArtworkRow(db, id);
  return row ? toDto(row, r2PublicBaseUrl) : null;
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

/**
 * Inserts a metadata row only — callers that need R2 objects to exist first (i.e. real image
 * adds) upload via storage/r2.ts and media/imaging.ts before calling this. Mirrors
 * ClassifierKind auto-add behavior from CatalogPicker.EnsureKnownAsync in the CLI.
 */
export function createArtworkRow(db: DatabaseSync, input: CreateArtworkInput): ArtworkRow {
  const isVideo = input.type === "video";
  if (isVideo && !input.videoId) {
    throw new Error("videoId is required when type is 'video'.");
  }

  const tags = input.tags ?? [];
  const groups = input.groups ?? [];
  if (input.category) ensureClassifier(db, "Category", input.category);
  if (input.medium) ensureClassifier(db, "Medium", input.medium);
  for (const tag of tags) ensureClassifier(db, "Tag", tag);
  for (const group of groups) ensureClassifier(db, "Group", group);

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

  markDirty(db);
  return fetchArtworkRow(db, Number(result.lastInsertRowid))!;
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

export function updateArtworkRow(db: DatabaseSync, id: number, patch: UpdateArtworkInput): ArtworkRow | null {
  const existing = fetchArtworkRow(db, id);
  if (!existing) return null;

  if (patch.category) ensureClassifier(db, "Category", patch.category);
  if (patch.medium) ensureClassifier(db, "Medium", patch.medium);
  for (const tag of patch.tags ?? []) ensureClassifier(db, "Tag", tag);
  for (const group of patch.groups ?? []) ensureClassifier(db, "Group", group);

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

  if (setClauses.length === 0) return existing;

  db.prepare(`UPDATE Artworks SET ${setClauses.join(", ")} WHERE Id = @id`).run(params);
  markDirty(db);
  return fetchArtworkRow(db, id)!;
}

/** DB-only delete — callers that also need the R2 objects removed do that first via storage/r2.ts
 * (see tools/artworks.ts delete_artworks), same ordering the CLI's DeleteFlow uses. */
export function deleteArtworkRow(db: DatabaseSync, id: number): ArtworkRow | null {
  const existing = fetchArtworkRow(db, id);
  if (!existing) return null;

  db.prepare("DELETE FROM Artworks WHERE Id = @id").run({ id });
  markDirty(db);
  return existing;
}

export function allArtworkRows(db: DatabaseSync): ArtworkRow[] {
  return db.prepare("SELECT * FROM Artworks").all() as unknown as ArtworkRow[];
}

export interface CatalogStats {
  totalArtworks: number;
  imageCount: number;
  videoCount: number;
  byCategory: Record<string, number>;
  byMedium: Record<string, number>;
  byTag: Record<string, number>;
  byGroup: Record<string, number>;
}

export function getCatalogStats(db: DatabaseSync): CatalogStats {
  const rows = allArtworkRows(db);
  const stats: CatalogStats = {
    totalArtworks: rows.length,
    imageCount: 0,
    videoCount: 0,
    byCategory: {},
    byMedium: {},
    byTag: {},
    byGroup: {},
  };

  const bump = (bucket: Record<string, number>, key: string | null | undefined) => {
    if (!key) return;
    bucket[key] = (bucket[key] ?? 0) + 1;
  };

  for (const row of rows) {
    if (row.Type === "video") stats.videoCount++;
    else stats.imageCount++;

    bump(stats.byCategory, row.Category);
    bump(stats.byMedium, row.Medium);
    for (const tag of parseStringList(row.Tags)) bump(stats.byTag, tag);
    for (const group of parseStringList(row.Groups)) bump(stats.byGroup, group);
  }

  return stats;
}

/** Every R2 key currently referenced by any row (both original and thumb), used by key allocation
 * (media/keys.ts) to avoid clobbering an existing object on a title/slug collision. */
export function allReferencedR2Keys(db: DatabaseSync): Set<string> {
  const keys = new Set<string>();
  for (const row of allArtworkRows(db)) {
    if (row.R2Key) keys.add(row.R2Key);
    if (row.ThumbR2Key) keys.add(row.ThumbR2Key);
  }
  return keys;
}

export const CLASSIFIER_KINDS_FOR_ARTWORK_FIELD: Record<"category" | "medium", ClassifierKind> = {
  category: "Category",
  medium: "Medium",
};
