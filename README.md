# CodedByKay.ArtShow.Mcp

MCP server exposing the `CodedByKay.ArtShow.CLI` SQLite catalog
(`artwork.db`) to MCP clients (Claude Code, Claude Desktop, etc), with full
CRUD on artworks and classifiers.

This is a second writer of `artwork.db` alongside `CodedByKay.ArtShow.CLI`
itself (see `ArtShow.Workspace/AGENTS.md`) — both talk to the same SQLite
file in WAL mode, which supports that safely. It's DB-only, though: it never
touches R2 or YouTube. Deleting/replacing an artwork's actual image files
stays with the CLI's own "Delete artwork" / "Add artwork" flows, which own
the R2 client and credentials.

Uses Node's built-in `node:sqlite` module (no native dependencies like
`better-sqlite3` to build/install) — requires Node.js 22.5+.

## Setup

```
npm install
npm run build
```

## Tools

Read-only:
- `list_artworks` — filter/search artworks (id, type, category, medium, tag,
  group, title/description substring) with pagination and sorting.
- `get_artwork` — fetch one artwork by id.
- `list_classifiers` — known Category/Medium/Tag/Group values.
- `get_catalog_stats` — total/image/video counts plus per-value breakdowns.
- `get_publish_state` — whether the catalog has unpublished changes.

Mutating (all mark the catalog dirty / pending-publish, same as the CLI):
- `create_artwork` — insert a new row. Metadata only — pass an existing
  `r2Key`/`thumbR2Key` (already-uploaded image) or `videoId` (already on
  YouTube); new category/medium/tag/group values are auto-added to
  Classifiers, same as the CLI's Add flow.
- `update_artwork` — partial update by id; nullable fields can be explicitly
  set to `null` to clear them.
- `delete_artwork` — delete a row by id. Does **not** touch R2 — use the
  CLI's "Delete artwork" menu option for a delete that also removes the R2
  files.
- `create_classifier` / `rename_classifier` / `delete_classifier` — manage
  known Category/Medium/Tag/Group values. Rename cascades to every artwork
  using that value; delete refuses (reporting the usage count) unless
  `force: true`, which also unlinks it from those artworks first.
- `set_publish_dirty` — manually set/clear the pending-publish flag.

Each artwork result includes the same `imageUrl`/`thumbnailUrl`/`videoUrl`
fields the CLI's `publish` command writes to the site's `data/artwork.json`
(built from `R2Key`/`ThumbR2Key`/`VideoId`), so results are ready to use
without re-deriving URLs.

## Configuration

- `ARTSHOW_DB_PATH` — override the path to `artwork.db`. Defaults to
  `C:\Users\kaywi\dev\CodedByKay.ArtShow.CLI\Db\artwork.db`.
- `ARTSHOW_R2_PUBLIC_BASE_URL` — override the R2 public base URL used to
  build `imageUrl`/`thumbnailUrl`. Defaults to `https://kaysartshow.fyi`.

## Registering with a client

Example `mcpServers` entry (Claude Desktop / Claude Code MCP config):

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
