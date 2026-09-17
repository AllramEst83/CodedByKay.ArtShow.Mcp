import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult } from "../lib/format.js";
import { formatBytes } from "../lib/format.js";
import { isValidIsoDate } from "../lib/dates.js";
import { allArtworkRows, getCatalogStats, parseStringList } from "../db/artworks.js";
import { listClassifierRows } from "../db/classifiers.js";
import { getPublishState } from "../db/publish-state.js";
import { headPublicUrl, listAllObjects } from "../storage/r2.js";
import { guarded } from "./wrap.js";

const readOnlyHint = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const readOnlyOpenWorldHint = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerStatusTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_status",
    {
      title: "Get catalog + config status",
      description:
        "No network calls: catalog counts and classifier breakdown, the pending-publish flag, and the resolved " +
        "configuration (db path, site JSON path, R2 bucket/public URL, and where credentials were found — or " +
        "that they're missing). Useful as a first call to sanity-check the environment before doing anything else.",
      inputSchema: {},
      annotations: readOnlyHint,
    },
    guarded(() =>
      jsonResult({
        stats: getCatalogStats(ctx.db),
        publishState: getPublishState(ctx.db),
        config: {
          cliRoot: ctx.config.cliRoot,
          dbPath: ctx.config.dbPath,
          dbPathSource: ctx.config.dbPathSource,
          siteRepoPath: ctx.config.siteRepoPath,
          siteArtworkJsonPath: ctx.config.siteArtworkJsonPath,
          appSettingsPath: ctx.config.appSettingsPath,
          appSettingsFound: ctx.config.appSettingsFound,
          userSecretsPath: ctx.config.userSecretsPath,
          userSecretsFound: ctx.config.userSecretsFound,
          r2: {
            bucket: ctx.config.r2.bucket,
            accountId: ctx.config.r2.accountId,
            publicBaseUrl: ctx.config.r2.publicBaseUrl,
            hasCredentials: ctx.config.hasR2Credentials,
            accessKeyIdSource: ctx.config.r2.accessKeyIdSource,
            secretAccessKeySource: ctx.config.r2.secretAccessKeySource,
          },
        },
      }),
    ),
  );

  server.registerTool(
    "check_sync",
    {
      title: "Status / sync check",
      description:
        "Cross-references the SQLite catalog against what's actually in the R2 bucket: which referenced keys are " +
        "missing from the bucket, which bucket objects aren't referenced by any row (orphans), and total bytes. " +
        "Read-only against R2 (ListObjectsV2 + optional HEAD checks) — never writes. Pass verifyUrls: true to also " +
        "HEAD-check every referenced object's public URL at the CDN domain (slower — one request per key).",
      inputSchema: {
        verifyUrls: z.boolean().default(false),
      },
      annotations: readOnlyOpenWorldHint,
    },
    guarded(async ({ verifyUrls }) => {
      const rows = allArtworkRows(ctx.db);
      const client = ctx.getR2Client();
      const bucketObjects = await listAllObjects(client, ctx.config.r2.bucket);

      const referencedKeys = new Set<string>();
      const missingKeys: { id: number; title: string; field: "R2Key" | "ThumbR2Key"; key: string }[] = [];
      const rowsWithoutVideoId: { id: number; title: string }[] = [];

      for (const row of rows) {
        if (row.Type === "video") {
          if (!row.VideoId) rowsWithoutVideoId.push({ id: row.Id, title: row.Title });
          continue;
        }
        for (const [field, key] of [
          ["R2Key", row.R2Key],
          ["ThumbR2Key", row.ThumbR2Key],
        ] as const) {
          if (!key) continue;
          referencedKeys.add(key);
          if (!bucketObjects.has(key)) missingKeys.push({ id: row.Id, title: row.Title, field, key });
        }
      }

      const orphanedObjects = [...bucketObjects.keys()]
        .filter((k) => !referencedKeys.has(k))
        .sort()
        .map((key) => ({ key, bytes: bucketObjects.get(key)! }));

      let urlChecks: { key: string; url: string; ok: boolean; status: number | null }[] | undefined;
      if (verifyUrls) {
        urlChecks = [];
        for (const key of referencedKeys) {
          const url = `${ctx.config.r2.publicBaseUrl}/${key}`;
          const result = await headPublicUrl(url);
          urlChecks.push({ key, url, ok: result.ok, status: result.status });
        }
      }

      const totalBytes = [...bucketObjects.values()].reduce((a, b) => a + b, 0);

      return jsonResult({
        artworkCount: rows.length,
        bucketObjectCount: bucketObjects.size,
        totalBytes,
        totalBytesFormatted: formatBytes(totalBytes),
        missingKeys,
        rowsWithoutVideoId,
        orphanedObjects,
        urlChecks,
      });
    }),
  );

  server.registerTool(
    "verify_catalog",
    {
      title: "Verify catalog consistency",
      description:
        "DB-only consistency sweep the CLI has no equivalent of: image rows missing an R2 key, video rows missing " +
        "a videoId, malformed/invalid dates, empty titles, duplicate R2 keys, artworks using a classifier value " +
        "that isn't in the Classifiers table, and Classifiers entries unused by any artwork (informational, not " +
        "an error).",
      inputSchema: {},
      annotations: readOnlyHint,
    },
    guarded(() => {
      const rows = allArtworkRows(ctx.db);
      const classifierNames = {
        Category: new Set(listClassifierRows(ctx.db, { kind: "Category" }).map((c) => c.Name.toLowerCase())),
        Medium: new Set(listClassifierRows(ctx.db, { kind: "Medium" }).map((c) => c.Name.toLowerCase())),
        Tag: new Set(listClassifierRows(ctx.db, { kind: "Tag" }).map((c) => c.Name.toLowerCase())),
        Group: new Set(listClassifierRows(ctx.db, { kind: "Group" }).map((c) => c.Name.toLowerCase())),
      };

      const problems: { id: number; title: string; problem: string }[] = [];
      const seenKeys = new Map<string, number[]>();
      const usedClassifiers = { Category: new Set<string>(), Medium: new Set<string>(), Tag: new Set<string>(), Group: new Set<string>() };

      for (const row of rows) {
        if (!row.Title || row.Title.trim().length === 0) problems.push({ id: row.Id, title: row.Title, problem: "empty title" });
        if (!isValidIsoDate(row.AddedDate)) problems.push({ id: row.Id, title: row.Title, problem: `invalid addedDate "${row.AddedDate}"` });
        if (row.CreatedDate && !isValidIsoDate(row.CreatedDate))
          problems.push({ id: row.Id, title: row.Title, problem: `invalid createdDate "${row.CreatedDate}"` });

        if (row.Type === "video") {
          if (!row.VideoId) problems.push({ id: row.Id, title: row.Title, problem: "video row missing videoId" });
        } else {
          if (!row.R2Key) problems.push({ id: row.Id, title: row.Title, problem: "image row missing R2Key" });
          if (!row.ThumbR2Key) problems.push({ id: row.Id, title: row.Title, problem: "image row missing ThumbR2Key" });
          for (const key of [row.R2Key, row.ThumbR2Key]) {
            if (!key) continue;
            const ids = seenKeys.get(key) ?? [];
            ids.push(row.Id);
            seenKeys.set(key, ids);
          }
        }

        if (row.Category) {
          usedClassifiers.Category.add(row.Category.toLowerCase());
          if (!classifierNames.Category.has(row.Category.toLowerCase()))
            problems.push({ id: row.Id, title: row.Title, problem: `Category "${row.Category}" not in Classifiers table` });
        }
        if (row.Medium) {
          usedClassifiers.Medium.add(row.Medium.toLowerCase());
          if (!classifierNames.Medium.has(row.Medium.toLowerCase()))
            problems.push({ id: row.Id, title: row.Title, problem: `Medium "${row.Medium}" not in Classifiers table` });
        }
        for (const tag of parseStringList(row.Tags)) {
          usedClassifiers.Tag.add(tag.toLowerCase());
          if (!classifierNames.Tag.has(tag.toLowerCase()))
            problems.push({ id: row.Id, title: row.Title, problem: `Tag "${tag}" not in Classifiers table` });
        }
        for (const group of parseStringList(row.Groups)) {
          usedClassifiers.Group.add(group.toLowerCase());
          if (!classifierNames.Group.has(group.toLowerCase()))
            problems.push({ id: row.Id, title: row.Title, problem: `Group "${group}" not in Classifiers table` });
        }
      }

      for (const [key, ids] of seenKeys) {
        if (ids.length > 1) problems.push({ id: ids[0], title: "", problem: `R2 key "${key}" is referenced by multiple rows: ${ids.join(", ")}` });
      }

      const unusedClassifiers = (["Category", "Medium", "Tag", "Group"] as const).flatMap((kind) =>
        listClassifierRows(ctx.db, { kind })
          .filter((c) => !usedClassifiers[kind].has(c.Name.toLowerCase()))
          .map((c) => ({ kind, id: c.Id, name: c.Name })),
      );

      return jsonResult({ problemCount: problems.length, problems, unusedClassifiers });
    }),
  );
}
