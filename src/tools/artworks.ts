import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { ToolError } from "../lib/errors.js";
import { jsonResult } from "../lib/format.js";
import { isValidIsoDate, todayIsoDate, yearOf } from "../lib/dates.js";
import { parseYouTubeId } from "../lib/youtube.js";
import {
  allReferencedR2Keys,
  createArtworkRow,
  deleteArtworkRow,
  fetchArtworkRow,
  listArtworks,
  toDto,
  updateArtworkRow,
} from "../db/artworks.js";
import { withSavepoint } from "../db/connection.js";
import { createThumbnail, encodeOriginalAsWebp } from "../media/imaging.js";
import { KeyAllocator } from "../media/keys.js";
import { deleteObjects, headPublicUrl, uploadObject } from "../storage/r2.js";
import { checkMissingClassifiers, resolveClassifiers, type ClassifierMode, type OnMissingClassifiers } from "./classify.js";
import { guarded } from "./wrap.js";

const readOnlyHint = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeHint = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }; // openWorld: touches R2
const updateHint = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const deleteHint = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

const metadataFields = {
  title: z.string().min(1),
  description: z.string().optional(),
  addedDate: z.string().optional().describe("yyyy-MM-dd; defaults to today"),
  createdDate: z.string().optional().describe("yyyy-MM-dd"),
  category: z.string().optional(),
  medium: z.string().optional(),
  tags: z.array(z.string()).optional(),
  groups: z.array(z.string()).optional(),
};

const addItemSchema = z.object({
  file: z.string().optional().describe("Local path to the source image — exactly one of file/youtube per item"),
  youtube: z.string().optional().describe("YouTube video URL or bare id — you upload the clip yourself via YouTube Studio first"),
  ...metadataFields,
});

type AddItemInput = z.infer<typeof addItemSchema>;

interface AddItemResult {
  index: number;
  status: "created" | "error" | "dry-run";
  title: string;
  type?: "image" | "video";
  id?: number;
  r2Key?: string;
  thumbR2Key?: string;
  videoId?: string;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  sourceBytes?: number;
  encodedBytes?: number;
  thumbBytes?: number;
  sourceDeleted?: boolean;
  urlVerification?: { imageOk: boolean; thumbOk: boolean };
  classifiersCreated?: { kind: string; name: string }[];
  warning?: string;
  error?: string;
  vocabulary?: unknown;
}

interface AddOptions {
  deleteSourceAfterUpload: boolean;
  dryRun: boolean;
  onMissingClassifiers: OnMissingClassifiers;
  classifierMode: ClassifierMode;
  keyAllocator: KeyAllocator;
}

async function addOneItem(ctx: ServerContext, item: AddItemInput, index: number, opts: AddOptions): Promise<AddItemResult> {
  const label = `item[${index}] ("${item.title}")`;
  try {
    if (item.file && item.youtube) throw new ToolError(`${label}: pass exactly one of "file" or "youtube", not both.`);
    if (!item.file && !item.youtube) throw new ToolError(`${label}: pass either "file" (local image path) or "youtube" (video URL/id).`);
    if (item.addedDate && !isValidIsoDate(item.addedDate)) throw new ToolError(`${label}: addedDate must be a valid yyyy-MM-dd date.`);
    if (item.createdDate && !isValidIsoDate(item.createdDate)) throw new ToolError(`${label}: createdDate must be a valid yyyy-MM-dd date.`);

    const missing = checkMissingClassifiers(ctx.db, item, opts.onMissingClassifiers, label);
    const resolved = resolveClassifiers(ctx.db, item, opts.classifierMode);
    const addedDate = item.addedDate ?? todayIsoDate();
    const classifiersCreated = resolved.newlyCreated.map((c) => ({ kind: c.kind, name: c.name }));

    if (item.youtube) {
      const videoId = parseYouTubeId(item.youtube);
      if (!videoId) throw new ToolError(`${label}: couldn't find a YouTube video id in "${item.youtube}".`);

      if (opts.dryRun) {
        return { index, status: "dry-run", title: item.title, type: "video", videoId, warning: missing.warning, classifiersCreated };
      }

      const row = withSavepoint(ctx.db, () =>
        createArtworkRow(ctx.db, {
          title: item.title,
          type: "video",
          addedDate,
          description: item.description,
          createdDate: item.createdDate,
          category: resolved.category,
          medium: resolved.medium,
          tags: resolved.tags,
          groups: resolved.groups,
          videoId,
        }),
      );
      const dto = toDto(row, ctx.config.r2.publicBaseUrl);
      return {
        index,
        status: "created",
        title: dto.title,
        type: "video",
        id: dto.id,
        videoId,
        videoUrl: dto.videoUrl,
        thumbnailUrl: dto.thumbnailUrl,
        warning: missing.warning,
        classifiersCreated,
      };
    }

    // Image item.
    const filePath = item.file!;
    if (!existsSync(filePath)) throw new ToolError(`${label}: file not found: ${filePath}`);
    const sourceBuffer = await readFile(filePath);
    const [original, thumb] = await Promise.all([encodeOriginalAsWebp(sourceBuffer), createThumbnail(sourceBuffer)]);
    const year = yearOf(item.createdDate ?? addedDate);
    const keys = opts.keyAllocator.allocate(item.title, year);

    if (opts.dryRun) {
      return {
        index,
        status: "dry-run",
        title: item.title,
        type: "image",
        r2Key: keys.originalKey,
        thumbR2Key: keys.thumbKey,
        sourceBytes: sourceBuffer.length,
        encodedBytes: original.buffer.length,
        thumbBytes: thumb.buffer.length,
        warning: missing.warning,
        classifiersCreated,
      };
    }

    const client = ctx.getR2Client();
    const uploaded: string[] = [];
    try {
      await uploadObject(client, ctx.config.r2.bucket, keys.originalKey, original.buffer, "image/webp");
      uploaded.push(keys.originalKey);
      await uploadObject(client, ctx.config.r2.bucket, keys.thumbKey, thumb.buffer, "image/webp");
      uploaded.push(keys.thumbKey);
    } catch (err) {
      if (uploaded.length > 0) await deleteObjects(client, ctx.config.r2.bucket, uploaded).catch(() => {});
      throw new ToolError(`${label}: R2 upload failed (any partial upload was cleaned up): ${(err as Error).message}`);
    }

    let row;
    try {
      row = withSavepoint(ctx.db, () =>
        createArtworkRow(ctx.db, {
          title: item.title,
          type: "image",
          addedDate,
          description: item.description,
          createdDate: item.createdDate,
          category: resolved.category,
          medium: resolved.medium,
          tags: resolved.tags,
          groups: resolved.groups,
          r2Key: keys.originalKey,
          thumbR2Key: keys.thumbKey,
          originalPath: path.resolve(filePath),
        }),
      );
    } catch (err) {
      await deleteObjects(client, ctx.config.r2.bucket, uploaded).catch(() => {});
      throw new ToolError(
        `${label}: catalog insert failed after R2 upload succeeded — the uploaded objects were removed to avoid orphaning them: ${(err as Error).message}`,
      );
    }

    const dto = toDto(row, ctx.config.r2.publicBaseUrl);
    let sourceDeleted = false;
    let urlVerification: { imageOk: boolean; thumbOk: boolean } | undefined;
    if (opts.deleteSourceAfterUpload) {
      const [imgCheck, thumbCheck] = await Promise.all([headPublicUrl(dto.imageUrl!), headPublicUrl(dto.thumbnailUrl!)]);
      urlVerification = { imageOk: imgCheck.ok, thumbOk: thumbCheck.ok };
      if (imgCheck.ok && thumbCheck.ok) {
        try {
          await unlink(filePath);
          sourceDeleted = true;
        } catch {
          // Non-fatal — the artwork is fully added either way; report via sourceDeleted: false.
        }
      }
    }

    return {
      index,
      status: "created",
      title: dto.title,
      type: "image",
      id: dto.id,
      r2Key: keys.originalKey,
      thumbR2Key: keys.thumbKey,
      imageUrl: dto.imageUrl,
      thumbnailUrl: dto.thumbnailUrl,
      sourceBytes: sourceBuffer.length,
      encodedBytes: original.buffer.length,
      thumbBytes: thumb.buffer.length,
      sourceDeleted,
      urlVerification,
      warning: missing.warning,
      classifiersCreated,
    };
  } catch (err) {
    if (err instanceof ToolError) {
      return { index, status: "error", title: item.title, error: err.message, vocabulary: err.data };
    }
    return { index, status: "error", title: item.title, error: (err as Error).message };
  }
}

export function registerArtworkTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "list_artworks",
    {
      title: "List artworks",
      description:
        "List/search artworks in the CodedByKay ArtShow catalog. Supports filtering, sorting, and pagination; " +
        "returns the total match count plus a page of results.",
      inputSchema: {
        ids: z.array(z.number().int()).optional().describe("Exact artwork ids"),
        type: z.enum(["image", "video"]).optional(),
        category: z.string().optional().describe("Exact match, case-insensitive"),
        medium: z.string().optional().describe("Exact match, case-insensitive"),
        tag: z.string().optional().describe("Artworks whose Tags list contains this value, case-insensitive"),
        group: z.string().optional().describe("Artworks whose Groups list contains this value, case-insensitive"),
        search: z.string().optional().describe("Case-insensitive substring match against title/description"),
        addedAfter: z.string().optional().describe("yyyy-MM-dd, inclusive"),
        addedBefore: z.string().optional().describe("yyyy-MM-dd, inclusive"),
        missingR2Key: z.boolean().optional().describe("Image rows with no R2Key set (incomplete adds)"),
        orderBy: z.enum(["id", "addedDate", "title"]).default("id"),
        orderDir: z.enum(["asc", "desc"]).default("asc"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: readOnlyHint,
    },
    guarded((args) => jsonResult(listArtworks(ctx.db, ctx.config.r2.publicBaseUrl, args))),
  );

  server.registerTool(
    "get_artwork",
    {
      title: "Get artwork(s) by id",
      description: "Fetch one or more artworks by id. Ids not found are simply omitted from the result.",
      inputSchema: { ids: z.array(z.number().int()).min(1) },
      annotations: readOnlyHint,
    },
    guarded(({ ids }) => jsonResult(listArtworks(ctx.db, ctx.config.r2.publicBaseUrl, { ids, limit: ids.length }).items)),
  );

  server.registerTool(
    "add_artworks",
    {
      title: "Add artworks (batch)",
      description:
        "Add one or more artworks in a single call — images or YouTube videos, mixed freely. For each image: " +
        "EXIF-orients, encodes a full-res WebP + 600w thumbnail, uploads both to R2, inserts the catalog row, " +
        "HEAD-verifies both public URLs are live, then deletes the local source file (see deleteSourceAfterUpload). " +
        "Every item succeeds or fails independently — one bad item doesn't abort the batch. " +
        "\n\nClassification: if you weren't told an item's category/medium/tags/groups, look at the image yourself " +
        "and call list_classifiers first to see the established vocabulary — pick from what's already used rather " +
        "than inventing new values. By default (onMissingClassifiers: \"error\") an item with none of those four " +
        "fields set is rejected with the full vocabulary attached so you can retry immediately.",
      inputSchema: {
        items: z.array(addItemSchema).min(1),
        deleteSourceAfterUpload: z.boolean().default(true).describe("Delete the local file after both R2 URLs verify live (image items only)"),
        dryRun: z.boolean().default(false).describe("Validate, encode sizes, and resolve classifiers without uploading or writing anything"),
        onMissingClassifiers: z
          .enum(["error", "warn", "allow"])
          .default("error")
          .describe("What to do when an item has no category/medium/tags/groups at all"),
        classifierMode: z
          .enum(["strict", "lenient"])
          .default("lenient")
          .describe("strict rejects values not already in the vocabulary (suggesting near-matches); lenient auto-creates them, like the CLI"),
      },
      annotations: writeHint,
    },
    guarded(async ({ items, deleteSourceAfterUpload, dryRun, onMissingClassifiers, classifierMode }) => {
      const keyAllocator = new KeyAllocator(allReferencedR2Keys(ctx.db));
      const opts: AddOptions = { deleteSourceAfterUpload, dryRun, onMissingClassifiers, classifierMode, keyAllocator };

      const results: AddItemResult[] = [];
      for (let i = 0; i < items.length; i++) {
        results.push(await addOneItem(ctx, items[i], i, opts));
      }

      const created = results.filter((r) => r.status === "created").length;
      const failed = results.filter((r) => r.status === "error").length;
      return jsonResult({ dryRun, created, failed, total: items.length, items: results });
    }),
  );

  const nullableString = z.string().nullable().optional();
  const updateItemSchema = z.object({
    id: z.number().int(),
    title: z.string().min(1).optional(),
    type: z.enum(["image", "video"]).optional(),
    addedDate: z.string().optional(),
    description: nullableString,
    createdDate: nullableString,
    category: nullableString,
    medium: nullableString,
    tags: z.array(z.string()).optional(),
    groups: z.array(z.string()).optional(),
    r2Key: nullableString,
    thumbR2Key: nullableString,
    videoId: nullableString,
    originalPath: z.string().optional(),
  });

  server.registerTool(
    "update_artworks",
    {
      title: "Update artworks (batch)",
      description:
        "Partially update one or more artworks by id — only fields provided per item are changed. Nullable fields " +
        "(description/createdDate/category/medium/r2Key/thumbR2Key/videoId) can be explicitly set to null to clear " +
        "them. category/medium/tags/groups are resolved against the classifier vocabulary the same way add_artworks " +
        "does (see classifierMode). Does NOT touch R2 or re-encode images — for swapping an artwork's actual image " +
        "file, use replace_artwork_image instead.",
      inputSchema: {
        items: z.array(updateItemSchema).min(1),
        classifierMode: z.enum(["strict", "lenient"]).default("lenient"),
      },
      annotations: updateHint,
    },
    guarded(({ items, classifierMode }) => {
      const results = items.map((item) => {
        const { id, ...patch } = item;
        try {
          const resolved = resolveClassifiers(
            ctx.db,
            { category: patch.category ?? undefined, medium: patch.medium ?? undefined, tags: patch.tags, groups: patch.groups },
            classifierMode,
          );
          const row = updateArtworkRow(ctx.db, id, {
            ...patch,
            category: patch.category === null ? null : (resolved.category ?? undefined),
            medium: patch.medium === null ? null : (resolved.medium ?? undefined),
            tags: resolved.tags,
            groups: resolved.groups,
          });
          if (!row) return { id, status: "error" as const, error: `Artwork ${id} not found.` };
          return {
            id,
            status: "updated" as const,
            classifiersCreated: resolved.newlyCreated,
            artwork: toDto(row, ctx.config.r2.publicBaseUrl),
          };
        } catch (err) {
          const message = err instanceof ToolError ? err.message : (err as Error).message;
          return { id, status: "error" as const, error: message };
        }
      });
      return jsonResult({ updated: results.filter((r) => r.status === "updated").length, failed: results.filter((r) => r.status === "error").length, items: results });
    }),
  );

  server.registerTool(
    "delete_artworks",
    {
      title: "Delete artworks (batch)",
      description:
        "Delete one or more artworks by id, including their R2 objects (the real CLI 'Delete artwork' behavior — " +
        "pass keepFiles: true to leave the R2 objects in place, e.g. if you know another row still needs them). " +
        "Requires confirm: true. Video rows have no R2 objects to remove.",
      inputSchema: {
        ids: z.array(z.number().int()).min(1),
        confirm: z.boolean().describe("Must be true — this permanently deletes catalog rows and (unless keepFiles) R2 objects"),
        keepFiles: z.boolean().default(false).describe("Delete the catalog row(s) but leave any R2 objects in the bucket"),
      },
      annotations: deleteHint,
    },
    guarded(async ({ ids, confirm, keepFiles }) => {
      if (!confirm) throw new ToolError("Pass confirm: true to delete — this cannot be undone.");

      const results: { id: number; status: "deleted" | "not-found"; r2KeysRemoved?: string[] }[] = [];
      for (const id of ids) {
        const existing = fetchArtworkRow(ctx.db, id);
        if (!existing) {
          results.push({ id, status: "not-found" });
          continue;
        }

        const keysToRemove = [existing.R2Key, existing.ThumbR2Key].filter((k): k is string => !!k);
        if (!keepFiles && keysToRemove.length > 0 && ctx.config.hasR2Credentials) {
          await deleteObjects(ctx.getR2Client(), ctx.config.r2.bucket, keysToRemove).catch((err) => {
            // Mirrors the CLI: it doesn't roll back the DB delete if the R2 delete has trouble —
            // report and continue rather than leaving the row stuck because R2 hiccuped.
            console.error(`delete_artworks: failed to remove R2 objects for #${id}: ${(err as Error).message}`);
          });
        }

        deleteArtworkRow(ctx.db, id);
        results.push({ id, status: "deleted", r2KeysRemoved: keepFiles ? [] : keysToRemove });
      }

      return jsonResult({ deleted: results.filter((r) => r.status === "deleted").length, results });
    }),
  );

  server.registerTool(
    "replace_artwork_image",
    {
      title: "Replace an artwork's image file",
      description:
        "Points an existing image artwork at a new local file: encodes + uploads new R2 objects, updates the row, " +
        "then removes the old R2 objects. Verifies the new URLs are live before deleting the old objects and " +
        "(if deleteSourceAfterUpload) the new local source. The one workflow the CLI has no direct answer for " +
        "short of delete-and-re-add.",
      inputSchema: {
        id: z.number().int(),
        file: z.string().describe("Local path to the replacement image"),
        deleteSourceAfterUpload: z.boolean().default(true),
      },
      annotations: writeHint,
    },
    guarded(async ({ id, file, deleteSourceAfterUpload }) => {
      const existing = fetchArtworkRow(ctx.db, id);
      if (!existing) throw new ToolError(`Artwork ${id} not found.`);
      if (existing.Type === "video") throw new ToolError(`Artwork ${id} is a video row — use update_artworks to change its videoId instead.`);
      if (!existsSync(file)) throw new ToolError(`File not found: ${file}`);

      const sourceBuffer = await readFile(file);
      const [original, thumb] = await Promise.all([encodeOriginalAsWebp(sourceBuffer), createThumbnail(sourceBuffer)]);
      const year = yearOf(existing.CreatedDate ?? existing.AddedDate);
      const allocator = new KeyAllocator(allReferencedR2Keys(ctx.db));
      const keys = allocator.allocate(existing.Title, year);

      const client = ctx.getR2Client();
      const uploaded: string[] = [];
      try {
        await uploadObject(client, ctx.config.r2.bucket, keys.originalKey, original.buffer, "image/webp");
        uploaded.push(keys.originalKey);
        await uploadObject(client, ctx.config.r2.bucket, keys.thumbKey, thumb.buffer, "image/webp");
        uploaded.push(keys.thumbKey);
      } catch (err) {
        if (uploaded.length > 0) await deleteObjects(client, ctx.config.r2.bucket, uploaded).catch(() => {});
        throw new ToolError(`R2 upload failed (any partial upload was cleaned up): ${(err as Error).message}`);
      }

      const row = updateArtworkRow(ctx.db, id, { r2Key: keys.originalKey, thumbR2Key: keys.thumbKey })!;
      const dto = toDto(row, ctx.config.r2.publicBaseUrl);

      const [imgCheck, thumbCheck] = await Promise.all([headPublicUrl(dto.imageUrl!), headPublicUrl(dto.thumbnailUrl!)]);
      const urlVerification = { imageOk: imgCheck.ok, thumbOk: thumbCheck.ok };

      const oldKeys = [existing.R2Key, existing.ThumbR2Key].filter((k): k is string => !!k);
      let oldKeysRemoved = false;
      if (imgCheck.ok && thumbCheck.ok && oldKeys.length > 0) {
        await deleteObjects(client, ctx.config.r2.bucket, oldKeys);
        oldKeysRemoved = true;
      }

      let sourceDeleted = false;
      if (deleteSourceAfterUpload && imgCheck.ok && thumbCheck.ok) {
        try {
          await unlink(file);
          sourceDeleted = true;
        } catch {
          // non-fatal
        }
      }

      return jsonResult({ artwork: dto, oldKeysRemoved, oldKeys, urlVerification, sourceDeleted });
    }),
  );
}
