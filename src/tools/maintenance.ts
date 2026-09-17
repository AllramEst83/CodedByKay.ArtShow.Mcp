import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, formatBytes } from "../lib/format.js";
import { allReferencedR2Keys } from "../db/artworks.js";
import { deleteObjects, listAllObjects } from "../storage/r2.js";
import { guarded } from "./wrap.js";

const deleteHint = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

export function registerMaintenanceTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "prune_orphaned_r2_objects",
    {
      title: "Prune orphaned R2 objects",
      description:
        "Deletes bucket objects no catalog row references (e.g. leftovers from a failed add, or an old test " +
        "upload). Dry-run by default — lists what would be deleted without touching anything; pass confirm: true " +
        "to actually delete. Always re-check with check_sync first if you're not sure why an object is orphaned.",
      inputSchema: {
        confirm: z.boolean().default(false),
      },
      annotations: deleteHint,
    },
    guarded(async ({ confirm }) => {
      const client = ctx.getR2Client();
      const bucketObjects = await listAllObjects(client, ctx.config.r2.bucket);
      const referenced = allReferencedR2Keys(ctx.db);

      const orphaned = [...bucketObjects.keys()]
        .filter((k) => !referenced.has(k))
        .sort()
        .map((key) => ({ key, bytes: bucketObjects.get(key)! }));
      const totalBytes = orphaned.reduce((a, o) => a + o.bytes, 0);

      if (orphaned.length === 0) {
        return jsonResult({ dryRun: !confirm, deleted: 0, orphaned: [], totalBytesFormatted: formatBytes(0) });
      }

      if (!confirm) {
        return jsonResult({
          dryRun: true,
          wouldDelete: orphaned.length,
          orphaned,
          totalBytesFormatted: formatBytes(totalBytes),
          note: "Pass confirm: true to actually delete these objects.",
        });
      }

      await deleteObjects(client, ctx.config.r2.bucket, orphaned.map((o) => o.key));
      return jsonResult({ dryRun: false, deleted: orphaned.length, orphaned, totalBytesFormatted: formatBytes(totalBytes) });
    }),
  );
}
