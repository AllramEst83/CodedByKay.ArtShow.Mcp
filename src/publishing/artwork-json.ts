import type { ArtworkRow } from "../lib/types.js";
import { parseStringList } from "../db/artworks.js";
import { obj, serializeDotnetJson, type JVal } from "./dotnet-json-encoder.js";

/** Mirrors CodedByKay.ArtShow.CLI/Publishing/ArtworkJsonWriter.cs ToJsonItem — same field
 * derivations, same property order (Id, Type, AddedDate, Title, Description, CreatedDate,
 * Category, Tags, Groups, Medium, ImageUrl, VideoUrl, ThumbnailUrl), which is what
 * System.Text.Json emits for ArtworkJsonItem's declared property order. Don't reorder these
 * without checking the C# class — the JSON property order is part of the published contract with
 * CodedByKay.ArtShow's frontend consumers (gallery.js/filters.js/groups.js/pagination.js), even
 * though none of them currently rely on key order specifically. */
function toJsonItem(row: ArtworkRow, r2PublicBaseUrl: string): JVal {
  const isVideo = row.Type === "video";
  const tags: JVal = parseStringList(row.Tags);
  const groups: JVal = parseStringList(row.Groups);

  const imageUrl = !isVideo && row.R2Key ? `${r2PublicBaseUrl}/${row.R2Key}` : null;
  const videoUrl = isVideo && row.VideoId ? `https://www.youtube-nocookie.com/embed/${row.VideoId}` : null;
  const thumbnailUrl = isVideo
    ? row.VideoId
      ? `https://img.youtube.com/vi/${row.VideoId}/hqdefault.jpg`
      : null
    : row.ThumbR2Key
      ? `${r2PublicBaseUrl}/${row.ThumbR2Key}`
      : null;

  return obj([
    ["id", String(row.Id)],
    ["type", row.Type ?? null],
    ["addedDate", row.AddedDate],
    ["title", row.Title],
    ["description", row.Description],
    ["createdDate", row.CreatedDate],
    ["category", row.Category],
    ["tags", tags],
    ["groups", groups],
    ["medium", row.Medium],
    ["imageUrl", imageUrl],
    ["videoUrl", videoUrl],
    ["thumbnailUrl", thumbnailUrl],
  ]);
}

/** Mirrors PublishFlow.RunAsync's ordering: `artworks.OrderBy(a => a.AddedDate)`, a stable sort
 * over rows enumerated with no explicit ORDER BY (which SQLite returns in rowid/Id order for a
 * plain table scan) — so ties on AddedDate keep Id-ascending order. We sort by Id first ourselves
 * so this doesn't depend on the caller's fetch order or on SQLite's unspecified-order behavior. */
export function buildArtworkJsonItems(rows: ArtworkRow[], r2PublicBaseUrl: string): JVal[] {
  const sorted = [...rows].sort((a, b) => a.Id - b.Id).sort((a, b) => a.AddedDate.localeCompare(b.AddedDate));
  return sorted.map((row) => toJsonItem(row, r2PublicBaseUrl));
}

export function writeArtworkJsonText(rows: ArtworkRow[], r2PublicBaseUrl: string): string {
  return serializeDotnetJson(buildArtworkJsonItems(rows, r2PublicBaseUrl));
}
