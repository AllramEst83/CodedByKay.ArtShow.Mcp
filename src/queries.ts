import type { SQLInputValue } from "node:sqlite";
import { db, parseStringList } from "./db.js";
import type { ArtworkDto, ArtworkRow, ClassifierRow, PublishStateRow } from "./types.js";

// Same default as CodedByKay.ArtShow.CLI's R2Options.PublicBaseUrl (appsettings.json) — the
// custom domain in front of the R2 bucket, never the bucket's r2.dev URL. See
// ArtShow.Workspace/AGENTS.md "Key decisions".
const R2_PUBLIC_BASE_URL = (process.env.ARTSHOW_R2_PUBLIC_BASE_URL ?? "https://kaysartshow.fyi").replace(/\/+$/, "");

export function toDto(row: ArtworkRow): ArtworkDto {
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
    imageUrl: !isVideo && row.R2Key ? `${R2_PUBLIC_BASE_URL}/${row.R2Key}` : null,
    videoUrl: isVideo && row.VideoId ? `https://www.youtube-nocookie.com/embed/${row.VideoId}` : null,
    thumbnailUrl: isVideo
      ? row.VideoId
        ? `https://img.youtube.com/vi/${row.VideoId}/hqdefault.jpg`
        : null
      : row.ThumbR2Key
        ? `${R2_PUBLIC_BASE_URL}/${row.ThumbR2Key}`
        : null,
  };
}

export interface ListArtworksFilter {
  id?: number;
  type?: "image" | "video";
  category?: string;
  medium?: string;
  tag?: string;
  group?: string;
  search?: string;
  orderBy?: "id" | "addedDate" | "title";
  orderDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface ListArtworksResult {
  total: number;
  items: ArtworkDto[];
}

export function listArtworks(filter: ListArtworksFilter): ListArtworksResult {
  const clauses: string[] = [];
  const params: Record<string, SQLInputValue> = {};

  if (filter.id !== undefined) {
    clauses.push("Id = @id");
    params.id = filter.id;
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

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM Artworks ${where}`).all(params) as unknown as ArtworkRow[];

  // Tags/Groups are stored as JSON text, and matching a single value inside that array is
  // awkward and injection-prone in raw SQL LIKE — filter in JS instead. The catalog is small
  // (tens of rows), so a full scan here is cheap.
  let dtos = rows.map(toDto);
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

export function getArtwork(id: number): ArtworkDto | null {
  const row = db.prepare("SELECT * FROM Artworks WHERE Id = @id").get({ id }) as unknown as ArtworkRow | undefined;
  return row ? toDto(row) : null;
}

export interface ListClassifiersFilter {
  kind?: "Category" | "Medium" | "Tag" | "Group";
  search?: string;
}

export function listClassifiers(filter: ListClassifiersFilter): ClassifierRow[] {
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

export function getPublishState(): { dirty: boolean } {
  const row = db.prepare("SELECT * FROM PublishStates WHERE Id = 1").get() as unknown as PublishStateRow | undefined;
  return { dirty: row ? row.Dirty !== 0 : false };
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

export function getCatalogStats(): CatalogStats {
  const rows = db.prepare("SELECT * FROM Artworks").all() as unknown as ArtworkRow[];
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
