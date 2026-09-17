import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult } from "../lib/format.js";
import { ToolError } from "../lib/errors.js";
import {
  createClassifier,
  deleteClassifier,
  listClassifiersWithUsage,
  matchClassifierCandidates,
  renameClassifier,
} from "../db/classifiers.js";
import { guarded } from "./wrap.js";

const readOnlyHint = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeHint = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const updateHint = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const deleteHint = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const classifierKindSchema = z.enum(["Category", "Medium", "Tag", "Group"]);

export function registerClassifierTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "list_classifiers",
    {
      title: "List classifiers",
      description:
        "The classification vocabulary — known Category/Medium/Tag/Group values, each with its usage count and " +
        "a few example artwork titles, so you can tell an established value from a one-off typo. Call this before " +
        "classifying a new artwork so you pick from what's actually in use. Pass `match` (candidate strings you're " +
        "considering) to fuzzy-match each one against the existing vocabulary — useful for normalizing " +
        "'watercolour' to 'watercolor' instead of creating a near-duplicate.",
      inputSchema: {
        kind: classifierKindSchema.optional(),
        search: z.string().optional().describe("Case-insensitive substring match against the name"),
        match: z.array(z.string()).optional().describe("Candidate values to fuzzy-match against the vocabulary (optionally scoped by kind)"),
      },
      annotations: readOnlyHint,
    },
    guarded(({ kind, search, match }) => {
      const vocabulary = listClassifiersWithUsage(ctx.db, { kind, search });
      const matches = match ? matchClassifierCandidates(ctx.db, match, kind) : undefined;
      return jsonResult({ vocabulary, matches });
    }),
  );

  server.registerTool(
    "create_classifiers",
    {
      title: "Create classifiers (batch)",
      description:
        "Add known values for Category/Medium/Tag/Group without attaching them to any artwork yet. Each entry " +
        "errors independently if that kind+name already exists (case-insensitive).",
      inputSchema: {
        items: z.array(z.object({ kind: classifierKindSchema, name: z.string().min(1) })).min(1),
      },
      annotations: writeHint,
    },
    guarded(({ items }) => {
      const results = items.map((item) => {
        try {
          return { ...item, status: "created" as const, classifier: createClassifier(ctx.db, item.kind, item.name) };
        } catch (err) {
          return { ...item, status: "error" as const, error: (err as Error).message };
        }
      });
      return jsonResult({ created: results.filter((r) => r.status === "created").length, items: results });
    }),
  );

  server.registerTool(
    "rename_classifier",
    {
      title: "Rename classifier",
      description:
        "Rename a classifier by id, cascading into every artwork currently using it (Category/Medium fields, or " +
        "Tags/Groups entries — deduped if an artwork already had the new name too). If the target name already " +
        "exists as a different classifier of the same kind, this errors unless merge: true, which folds the " +
        "rename into that existing classifier instead — the fix for cleaning up a near-duplicate like " +
        "'watercolour'/'watercolor' into one value.",
      inputSchema: {
        id: z.number().int(),
        newName: z.string().min(1),
        merge: z.boolean().default(false),
      },
      annotations: updateHint,
    },
    guarded(({ id, newName, merge }) => jsonResult(renameClassifier(ctx.db, id, newName, merge))),
  );

  server.registerTool(
    "delete_classifier",
    {
      title: "Delete classifier",
      description:
        "Delete a classifier by id. If it's currently used by any artwork, this refuses and reports the usage " +
        "count unless force is true — in which case it's also removed from those artworks (Category/Medium set to " +
        "null, or stripped from Tags/Groups) before being deleted.",
      inputSchema: {
        id: z.number().int(),
        force: z.boolean().default(false),
      },
      annotations: deleteHint,
    },
    guarded(({ id, force }) => {
      const result = deleteClassifier(ctx.db, id, force);
      if (!result.deleted && !force && result.usageCount === 0 && result.message?.includes("not found")) {
        throw new ToolError(result.message);
      }
      return jsonResult(result);
    }),
  );
}
