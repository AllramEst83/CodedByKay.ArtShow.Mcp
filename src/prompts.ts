import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "./context.js";

export function registerPrompts(server: McpServer, ctx: ServerContext): void {
  server.registerPrompt(
    "add-new-drawings",
    {
      title: "Add new drawings",
      description:
        "Walks through adding every image in a staging folder to the ArtShow catalog: classify each one " +
        "yourself against the existing vocabulary, upload, and publish.",
      argsSchema: {
        folder: z.string().optional().describe(`Local folder to scan (default: ${ctx.config.stagingFolderPath})`),
      },
    },
    ({ folder }) => {
      const targetFolder = folder ?? ctx.config.stagingFolderPath;
      const text = [
        `Add every image file in "${targetFolder}" to the ArtShow catalog:`,
        "",
        "1. List the folder's image files (jpg/jpeg/png/webp/heic — skip anything else).",
        "2. Call list_classifiers to see the established Category/Medium/Tag/Group vocabulary before writing anything.",
        "3. For each image: look at it yourself and write a title, a short description, category, medium, tags, and " +
          "groups — prefer existing vocabulary values over inventing new ones, and only add a new value when nothing " +
          "established actually fits. If you weren't given a createdDate, leave it unset rather than guessing.",
        "4. Call add_artworks once with all the items together (not one call per image). Leave " +
          "deleteSourceAfterUpload at its default (true) unless told otherwise — it only deletes a source file " +
          "after both its R2 URLs verify live.",
        "5. If any item comes back with status \"error\" because classifiers were missing, its result carries the " +
          "full vocabulary — reclassify just that item from the image and retry it.",
        "6. Call publish and report the diff (added/removed/modified titles) — publish only writes " +
          "data/artwork.json, it does not commit or push, so tell the user to review and push the site repo " +
          "themselves.",
      ].join("\n");

      return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
    },
  );
}
