import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult } from "../lib/format.js";
import { allArtworkRows } from "../db/artworks.js";
import { getPublishState, markPublished, setPublishDirty } from "../db/publish-state.js";
import { writeArtworkJsonText } from "../publishing/artwork-json.js";
import { diffArtworkJson } from "../publishing/diff.js";
import { guarded } from "./wrap.js";

const readOnlyHint = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const updateHint = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Best-effort: reports whether the site repo already had uncommitted changes to
 * data/artwork.json *before* this publish touched it, so the diff summary can distinguish "this
 * publish's own changes" from "Kay already had something pending here." Returns undefined if git
 * isn't available or the path isn't a repo — this is informational, never blocks a publish. */
function gitDirtyBeforePublish(siteRepoPath: string): boolean | undefined {
  try {
    const out = execFileSync("git", ["-C", siteRepoPath, "status", "--porcelain", "--", "data/artwork.json"], {
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return undefined;
  }
}

export function registerPublishTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "publish",
    {
      title: "Publish artwork.json",
      description:
        "Writes data/artwork.json into the site repo, byte-identically to what CodedByKay.ArtShow.CLI's Publish " +
        "menu action produces, and clears the pending-publish flag. Metadata only — does NOT commit or push; " +
        "review the diff this returns, then commit + push the site repo yourself (Netlify auto-deploys on push). " +
        "dryRun computes the diff without writing or clearing the flag.",
      inputSchema: {
        dryRun: z.boolean().default(false),
      },
      annotations: updateHint,
    },
    guarded(({ dryRun }) => {
      const rows = allArtworkRows(ctx.db);
      const newText = writeArtworkJsonText(rows, ctx.config.r2.publicBaseUrl);

      const targetPath = ctx.config.siteArtworkJsonPath;
      const oldText = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "[]";
      const diff = diffArtworkJson(JSON.parse(oldText || "[]"), JSON.parse(newText));

      const gitAlreadyDirty = gitDirtyBeforePublish(ctx.config.siteRepoPath);

      if (!dryRun) {
        mkdirSync(path.dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, newText, "utf8");
        markPublished(ctx.db);
      }

      return jsonResult({
        dryRun,
        wrote: !dryRun,
        path: targetPath,
        itemCount: rows.length,
        diff,
        gitAlreadyDirtyBeforePublish: gitAlreadyDirty,
        note: dryRun
          ? "Dry run — nothing written."
          : "Written. Nothing committed or pushed — review the diff, then commit + push the site repo yourself.",
      });
    }),
  );

  server.registerTool(
    "set_publish_state",
    {
      title: "Set publish state",
      description:
        "Directly set the catalog's pending-publish flag. Mutating tools already mark it dirty automatically and " +
        "publish already clears it — this is for manually clearing it (e.g. after publishing some other way) or " +
        "forcing it dirty.",
      inputSchema: { dirty: z.boolean() },
      annotations: updateHint,
    },
    guarded(({ dirty }) => jsonResult(setPublishDirty(ctx.db, dirty))),
  );

  server.registerTool(
    "get_publish_state",
    {
      title: "Get publish state",
      description: "Whether the catalog has changes since the last successful publish (the CLI's 'pending changes' indicator).",
      inputSchema: {},
      annotations: readOnlyHint,
    },
    guarded(() => jsonResult(getPublishState(ctx.db))),
  );
}
