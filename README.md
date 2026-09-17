# CodedByKay.ArtShow.Mcp

MCP server that does the whole `CodedByKay.ArtShow.CLI` workflow — add, edit,
view, and delete artwork; manage classifiers; publish `artwork.json`; check
catalog/R2 sync — from an MCP client (Claude Code, Claude Desktop, etc)
instead of the CLI's interactive TUI. Batch-capable throughout (add/update/
delete many artworks in one call) and can classify new artwork itself when
you don't hand it category/medium/tags/groups (see "Classification" below).

This is a second writer of `artwork.db` alongside `CodedByKay.ArtShow.CLI`
itself, and — new as of this rebuild — a second writer of R2 objects and of
the site's `data/artwork.json` too. See
`ArtShow.Workspace/working-on/mcp-rebuild-plan.md` for the full rationale and
`ArtShow.Workspace/AGENTS.md` for how this fits the rest of the workspace.
Both this server and the CLI talk to the same SQLite file in WAL mode, which
supports that safely (busy_timeout + a SAVEPOINT per batch item here).

Uses Node's built-in `node:sqlite` (no native DB dependency to build), plus
`sharp` for imaging and `@aws-sdk/client-s3` for R2 — both installed from
prebuilt binaries, no native build step. Requires Node.js 22.5+.

## Setup

```
npm install
npm run build
```

R2 credentials aren't configured separately — this server reads the exact
same sources the CLI does (see "Configuration" below), so if `dotnet run` in
`CodedByKay.ArtShow.CLI` already works, this does too.

## Tools

### Read / inspect
- `list_artworks` — filter (ids, type, category, medium, tag, group, text
  search, date range, missing-R2-key) + sort + paginate.
- `get_artwork` — fetch one or more artworks by id.
- `get_status` — no network: catalog counts, classifier breakdown, the
  pending-publish flag, and the resolved config (paths, R2 bucket, and where
  credentials were found or that they're missing). Good first call.
- `check_sync` — cross-references the catalog against the R2 bucket: keys
  referenced but missing, bucket objects orphaned (unreferenced), total
  bytes. `verifyUrls: true` also HEAD-checks every public URL.
- `verify_catalog` — DB-only consistency sweep the CLI has no equivalent of:
  missing R2 keys/video ids, invalid dates, empty titles, duplicate R2 keys,
  classifier values used by an artwork but not in the `Classifiers` table.

### Write — artworks
- `add_artworks` — **the centerpiece.** Add one or more artworks (images
  and/or YouTube videos, mixed freely) in a single call. Per image: EXIF-
  orients, encodes a full-res WebP (q90) + 600w WebP thumbnail (q75),
  allocates collision-free R2 keys, uploads both, inserts the row, marks the
  catalog dirty, HEAD-verifies both public URLs, then deletes the local
  source file (`deleteSourceAfterUpload`, default **true** — only deletes
  after both URLs verify live). Every item succeeds or fails independently.
  `dryRun: true` validates/encodes/resolves classifiers without uploading or
  writing anything. See "Classification" below for `onMissingClassifiers`
  and `classifierMode`.
- `update_artworks` — batch partial update by id; nullable fields
  (`description`/`createdDate`/`category`/`medium`/`r2Key`/`thumbR2Key`/
  `videoId`) explicitly settable to `null` to clear them. Doesn't touch R2 or
  re-encode images.
- `delete_artworks` — batch delete, **including R2 objects** (the CLI's real
  "Delete artwork" behavior) unless `keepFiles: true`. Requires
  `confirm: true`.
- `replace_artwork_image` — point an existing image row at a new local file:
  uploads new R2 objects, updates the row, verifies, then removes the old
  R2 objects. The one workflow the CLI has no direct answer for short of
  delete-and-re-add.
- `relocate_artwork_media` — batch-move an image row's R2 objects to their
  canonical `originals/<year>/<slug>.webp` / `thumbs/<year>/<slug>-600w.webp`
  path (year from `CreatedDate`, falling back to `AddedDate`) via a
  server-side R2 copy — no download, no re-encoding, bytes untouched. For
  when `CreatedDate` was corrected after upload and left the object under
  the wrong year folder. A row already at its canonical keys is left alone
  and reported `unchanged`; a manual copy done ahead of time (new key
  already present, old key already gone) is tolerated and still updates the
  row. Every id succeeds or fails independently.

### Classifiers
- `list_classifiers` — the vocabulary (Category/Medium/Tag/Group), each with
  a usage count and example titles. Pass `match: string[]` to fuzzy-match
  candidate values against it (surfaces "watercolour" → "watercolor" instead
  of letting a near-duplicate spelling become a second classifier).
- `create_classifiers` — batch add known values without attaching them to
  any artwork.
- `rename_classifier` — cascades into every artwork using it. `merge: true`
  folds a rename into an already-existing classifier of the same name
  instead of erroring — the real fix for a near-duplicate.
- `delete_classifier` — reports usage count; `force: true` to unlink from
  artworks and delete anyway.

### Publish
- `publish` — writes `data/artwork.json` **byte-identically** to what the
  CLI's `System.Text.Json` writer produces (see "Publish parity" below),
  clears the pending-publish flag, and returns a diff (ids added/removed,
  and which fields changed on modified ids). Metadata only — does **not**
  commit or push; review the diff, then commit + push the site repo
  yourself (Netlify auto-deploys on push). `dryRun: true` computes the diff
  without writing.
- `set_publish_state` / `get_publish_state` — read/manually set the
  pending-publish flag.

### Maintenance
- `prune_orphaned_r2_objects` — deletes bucket objects no catalog row
  references. Dry-run by default; `confirm: true` to execute.

Also: an MCP **resource** `artshow://classifiers` (the same vocabulary
`list_classifiers` returns, without a tool call) and an MCP **prompt**
`add-new-drawings` that walks through classifying-and-adding every image in
a staging folder end to end.

## Classification

This server can't see an image — classification is the calling agent's job.
Three things make that consistent instead of ad hoc:

1. **`list_classifiers` is the vocabulary**, with usage counts and example
   titles, so an agent picks an established value over inventing a new one.
2. **`onMissingClassifiers` on `add_artworks`** (default **`"error"`**): an
   item with no category/medium/tags/groups at all is rejected, and the
   error carries the *entire* vocabulary — so an agent that hits it can look
   at the image and retry immediately instead of a second round trip.
   `"warn"` inserts anyway with a flag on the result; `"allow"` is silent
   (the pre-rebuild behavior).
3. **`classifierMode`**: `"lenient"` (default, matches the CLI's own
   auto-add-on-first-use behavior) accepts a new value and creates it,
   reporting it in the result as `classifiersCreated`. `"strict"` rejects a
   value not already in the vocabulary — if something close exists
   ("watercolour" vs "watercolor") the error suggests it by name; if
   nothing does, it says so and points at `list_classifiers`.

## Publish parity

`CodedByKay.ArtShow.CLI` writes `data/artwork.json` via
`JsonSerializer.Serialize(items, new JsonSerializerOptions { WriteIndented = true })`.
For this server's `publish` to be a safe drop-in replacement (rather than
having every alternate publish between the CLI and this server rewrite the
whole file), `src/publishing/dotnet-json-encoder.ts` reimplements that
writer's exact output byte-for-byte: CRLF line endings, 2-space indent, no
trailing newline, comma-before-newline placement, empty arrays/objects
collapsed to `[]`/`{}`, and `JavaScriptEncoder.Default`'s escaping (`&`,
`'`, `<`, `>`, and everything above `0x7E` escaped as uppercase `\uXXXX`).
Verified with a byte-for-byte round-trip test against the live file — see
`src/test/dotnet-json-encoder.test.ts`.

## Configuration

Reads the **same sources `CodedByKay.ArtShow.CLI` does** (mirroring
`Program.cs`'s `ConfigurationBuilder` precedence — env vars win, then
dotnet user-secrets, then `appsettings.json`), so no separate credential
setup is needed if the CLI already works:

| Source | What it provides |
|---|---|
| `<CLI root>/appsettings.json` | `Catalog:DbPath`, `Publish:SiteRepoPath`, `R2:Bucket`/`AccountId`/`PublicBaseUrl` (and `R2:AccessKeyId`/`SecretAccessKey`, normally left empty here on purpose) |
| `%APPDATA%\Microsoft\UserSecrets\codedbykay-artshow-cli\secrets.json` | `R2:AccessKeyId` / `R2:SecretAccessKey` — read BOM-safe (dotnet writes this file with a UTF-8 BOM) |
| Environment variables | Override anything above — see below |

Env var overrides (all optional):

| Variable | Overrides |
|---|---|
| `ARTSHOW_CLI_ROOT` | Path to `CodedByKay.ArtShow.CLI` (default `C:\Users\kaywi\dev\CodedByKay.ArtShow.CLI`) — where `appsettings.json` is read from |
| `ARTSHOW_DB_PATH` | Full path to `artwork.db` (default: `<CLI root>` + `Catalog:DbPath`) |
| `ARTSHOW_SITE_REPO_PATH` | Site repo root (default `C:\Users\kaywi\dev\CodedByKay.ArtShow`) — `publish` writes to `<this>/data/artwork.json` |
| `ARTSHOW_STAGING_FOLDER` | Default `folder` for the `add-new-drawings` prompt |
| `ARTSHOW_R2_BUCKET`, `ARTSHOW_R2_ACCOUNT_ID`, `ARTSHOW_R2_PUBLIC_BASE_URL` | R2 bucket config |
| `ARTSHOW_R2_ACCESS_KEY_ID`, `ARTSHOW_R2_SECRET_ACCESS_KEY` | R2 credentials |

Call `get_status` to see exactly what was resolved and where each value
came from (including whether credentials were found and in which file).

## Safety

- Every destructive tool (`delete_artworks`, `prune_orphaned_r2_objects`)
  requires `confirm: true`; both plus `add_artworks`/`replace_artwork_image`
  support `dryRun`.
- A local source file is **never** deleted before both its R2 public URLs
  HEAD 200.
- If a catalog insert fails after an R2 upload already succeeded, the
  server best-effort deletes the just-uploaded objects rather than leaving
  them orphaned.
- This server never runs EF Core migrations and never creates tables — a
  schema mismatch at startup fails loudly and tells you to run the CLI once
  instead of silently improvising.
- Each batch item (in `add_artworks`/`update_artworks`) runs in its own
  SQLite `SAVEPOINT`, so one bad item can't corrupt the catalog or block the
  rest of the batch.

## Registering with a client

```json
{
  "mcpServers": {
    "artshow-catalog": {
      "command": "node",
      "args": ["C:\\Users\\kaywi\\dev\\CodedByKay.ArtShow.Mcp\\dist\\index.js"]
    }
  }
}
```

Or with the Claude Code CLI:

```
claude mcp add artshow-catalog -- node C:\Users\kaywi\dev\CodedByKay.ArtShow.Mcp\dist\index.js
```

## Development

```
npm run dev      # tsc --watch
npm test         # build, then run src/test/*.test.ts under node --test
```

Several tests read the **live** `artwork.db` and site `artwork.json`
read-only (never mutate) to check real-world parity — they skip gracefully
if those paths don't exist on the machine running them.
