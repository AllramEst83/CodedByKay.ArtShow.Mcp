# CodedByKay.ArtShow.Mcp

Read-only MCP server exposing the `CodedByKay.ArtShow.CLI` SQLite catalog
(`artwork.db`) to MCP clients (Claude Code, Claude Desktop, etc). It opens
the database read-only and never writes to it — `CodedByKay.ArtShow.CLI`
remains the sole writer, per `ArtShow.Workspace/AGENTS.md`.

Uses Node's built-in `node:sqlite` module (no native dependencies like
`better-sqlite3` to build/install) — requires Node.js 22.5+.

## Setup

```
npm install
npm run build
```

## Tools

- `list_artworks` — filter/search artworks (id, type, category, medium, tag,
  group, title/description substring) with pagination and sorting.
- `get_artwork` — fetch one artwork by id.
- `list_classifiers` — known Category/Medium/Tag/Group values.
- `get_catalog_stats` — total/image/video counts plus per-value breakdowns.
- `get_publish_state` — whether the catalog has unpublished changes.

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
