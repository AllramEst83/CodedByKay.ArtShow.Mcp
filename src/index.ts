#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DB_PATH } from "./db.js";
import { getArtwork, getCatalogStats, getPublishState, listArtworks, listClassifiers } from "./queries.js";
import {
  createArtwork,
  createClassifier,
  deleteArtwork,
  deleteClassifier,
  renameClassifier,
  setPublishDirty,
  updateArtwork,
} from "./mutations.js";

const server = new McpServer({
  name: "artshow-catalog",
  version: "0.2.0",
});

const readOnlyHint = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeHint = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const updateHint = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const deleteHint = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const classifierKindSchema = z.enum(["Category", "Medium", "Tag", "Group"]);

server.registerTool(
  "list_artworks",
  {
    title: "List artworks",
    description:
      "List/search artworks in the CodedByKay ArtShow catalog (artwork.db, owned by CodedByKay.ArtShow.CLI). " +
      "Supports filtering and pagination; returns the total match count plus a page of results.",
    inputSchema: {
      id: z.number().int().optional().describe("Exact artwork id"),
      type: z.enum(["image", "video"]).optional().describe("Filter to images or videos"),
      category: z.string().optional().describe("Exact category match, case-insensitive"),
      medium: z.string().optional().describe("Exact medium match, case-insensitive"),
      tag: z.string().optional().describe("Artworks whose Tags list contains this value, case-insensitive"),
      group: z.string().optional().describe("Artworks whose Groups list contains this value, case-insensitive"),
      search: z.string().optional().describe("Case-insensitive substring match against title/description"),
      orderBy: z.enum(["id", "addedDate", "title"]).default("id"),
      orderDir: z.enum(["asc", "desc"]).default("asc"),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    },
    annotations: readOnlyHint,
  },
  async (args) => {
    const result = listArtworks(args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "get_artwork",
  {
    title: "Get artwork by id",
    description: "Fetch a single artwork by its catalog id, or null if no such artwork exists.",
    inputSchema: {
      id: z.number().int().describe("Artwork id"),
    },
    annotations: readOnlyHint,
  },
  async ({ id }) => {
    const artwork = getArtwork(id);
    return { content: [{ type: "text", text: JSON.stringify(artwork, null, 2) }] };
  },
);

server.registerTool(
  "list_classifiers",
  {
    title: "List classifiers",
    description:
      "List known values for the catalog's four classifier kinds (Category, Medium, Tag, Group). " +
      "These are the pre-declared/auto-learned values CodedByKay.ArtShow.CLI offers when adding or editing " +
      "an artwork — independent of whether any artwork currently uses them.",
    inputSchema: {
      kind: z.enum(["Category", "Medium", "Tag", "Group"]).optional(),
      search: z.string().optional().describe("Case-insensitive substring match against the name"),
    },
    annotations: readOnlyHint,
  },
  async (args) => {
    const rows = listClassifiers(args);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
);

server.registerTool(
  "get_catalog_stats",
  {
    title: "Get catalog stats",
    description:
      "Summary counts for the catalog: total/image/video counts, and per-value counts for category, medium, tag, and group.",
    inputSchema: {},
    annotations: readOnlyHint,
  },
  async () => {
    const stats = getCatalogStats();
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
  },
);

server.registerTool(
  "get_publish_state",
  {
    title: "Get publish state",
    description:
      "Whether the catalog has changes since the last successful Publish (the CLI's 'pending changes' indicator).",
    inputSchema: {},
    annotations: readOnlyHint,
  },
  async () => {
    const state = getPublishState();
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
  },
);

server.registerTool(
  "create_artwork",
  {
    title: "Create artwork",
    description:
      "Insert a new artwork row into the catalog. This is metadata-only — it does not upload anything to R2 " +
      "or YouTube; pass r2Key/thumbR2Key (for an image already uploaded to the bucket) or videoId (for a video " +
      "already uploaded to YouTube). New category/medium/tag/group values are auto-added to Classifiers, same " +
      "as the CLI's Add flow. Marks the catalog dirty (pending publish).",
    inputSchema: {
      title: z.string().min(1),
      type: z.enum(["image", "video"]).default("image"),
      addedDate: z.string().optional().describe("yyyy-MM-dd; defaults to today"),
      description: z.string().optional(),
      createdDate: z.string().optional().describe("yyyy-MM-dd"),
      category: z.string().optional(),
      medium: z.string().optional(),
      tags: z.array(z.string()).optional(),
      groups: z.array(z.string()).optional(),
      r2Key: z.string().optional().describe("Existing R2 object key for the full-res image (image type only)"),
      thumbR2Key: z.string().optional().describe("Existing R2 object key for the thumbnail (image type only)"),
      videoId: z.string().optional().describe("YouTube video id — required when type is 'video'"),
      originalPath: z.string().optional(),
    },
    annotations: writeHint,
  },
  async (args) => {
    const artwork = createArtwork(args);
    return { content: [{ type: "text", text: JSON.stringify(artwork, null, 2) }] };
  },
);

server.registerTool(
  "update_artwork",
  {
    title: "Update artwork",
    description:
      "Partially update an artwork by id — only the fields provided are changed. Nullable fields " +
      "(description/createdDate/category/medium/r2Key/thumbR2Key/videoId) can be explicitly set to null to " +
      "clear them. New category/medium/tag/group values are auto-added to Classifiers. Marks the catalog dirty.",
    inputSchema: {
      id: z.number().int(),
      title: z.string().min(1).optional(),
      type: z.enum(["image", "video"]).optional(),
      addedDate: z.string().optional(),
      description: z.string().nullable().optional(),
      createdDate: z.string().nullable().optional(),
      category: z.string().nullable().optional(),
      medium: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      groups: z.array(z.string()).optional(),
      r2Key: z.string().nullable().optional(),
      thumbR2Key: z.string().nullable().optional(),
      videoId: z.string().nullable().optional(),
      originalPath: z.string().optional(),
    },
    annotations: updateHint,
  },
  async ({ id, ...patch }) => {
    const artwork = updateArtwork(id, patch);
    if (!artwork) {
      return { content: [{ type: "text", text: `Artwork ${id} not found.` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(artwork, null, 2) }] };
  },
);

server.registerTool(
  "delete_artwork",
  {
    title: "Delete artwork",
    description:
      "Delete an artwork row from the catalog by id. DB-only — this does NOT delete the artwork's files from " +
      "R2 (its R2Key/ThumbR2Key objects are left in the bucket). To delete an artwork and its R2 files together, " +
      "use the CLI's 'Delete artwork' menu option instead. Marks the catalog dirty.",
    inputSchema: {
      id: z.number().int(),
    },
    annotations: deleteHint,
  },
  async ({ id }) => {
    const deleted = deleteArtwork(id);
    return { content: [{ type: "text", text: JSON.stringify({ deleted }, null, 2) }] };
  },
);

server.registerTool(
  "create_classifier",
  {
    title: "Create classifier",
    description:
      "Add a known value for one of the four classifier kinds (Category, Medium, Tag, Group) without " +
      "attaching it to any artwork yet. Errors if that kind+name already exists (case-insensitive).",
    inputSchema: {
      kind: classifierKindSchema,
      name: z.string().min(1),
    },
    annotations: writeHint,
  },
  async ({ kind, name }) => {
    const classifier = createClassifier(kind, name);
    return { content: [{ type: "text", text: JSON.stringify(classifier, null, 2) }] };
  },
);

server.registerTool(
  "rename_classifier",
  {
    title: "Rename classifier",
    description:
      "Rename a classifier by id, cascading the rename to every artwork currently using it (Category/Medium " +
      "fields, or Tags/Groups list entries — deduped if the artwork already had the new name too). Marks the " +
      "catalog dirty if any artwork was touched.",
    inputSchema: {
      id: z.number().int(),
      newName: z.string().min(1),
    },
    annotations: updateHint,
  },
  async ({ id, newName }) => {
    const result = renameClassifier(id, newName);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "delete_classifier",
  {
    title: "Delete classifier",
    description:
      "Delete a classifier by id. If it's currently used by any artwork, this refuses and reports the usage " +
      "count unless force is true — in which case it's also removed from those artworks (Category/Medium set " +
      "to null, or stripped from the Tags/Groups list) before being deleted, and the catalog is marked dirty.",
    inputSchema: {
      id: z.number().int(),
      force: z.boolean().default(false).describe("Delete and unlink from artworks even if currently in use"),
    },
    annotations: deleteHint,
  },
  async ({ id, force }) => {
    const result = deleteClassifier(id, force);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "set_publish_dirty",
  {
    title: "Set publish state",
    description:
      "Directly set the catalog's dirty flag (the CLI's 'pending changes' indicator). Mutating tools here " +
      "already mark it dirty automatically — this is for manually clearing it (e.g. after publishing through " +
      "some other means) or forcing it dirty.",
    inputSchema: {
      dirty: z.boolean(),
    },
    annotations: updateHint,
  },
  async ({ dirty }) => {
    const state = setPublishDirty(dirty);
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`artshow-mcp connected (db: ${DB_PATH})`);
}

main().catch((err) => {
  console.error("artshow-mcp fatal error:", err);
  process.exit(1);
});
