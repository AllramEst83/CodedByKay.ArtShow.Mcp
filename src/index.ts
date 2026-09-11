#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DB_PATH } from "./db.js";
import { getArtwork, getCatalogStats, getPublishState, listArtworks, listClassifiers } from "./queries.js";

const server = new McpServer({
  name: "artshow-catalog",
  version: "0.1.0",
});

const readOnlyHint = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`artshow-mcp connected (db: ${DB_PATH})`);
}

main().catch((err) => {
  console.error("artshow-mcp fatal error:", err);
  process.exit(1);
});
