#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/connection.js";
import { assertSchema } from "./schema-guard.js";
import { ServerContext } from "./context.js";
import { registerArtworkTools } from "./tools/artworks.js";
import { registerClassifierTools } from "./tools/classifiers.js";
import { registerPublishTools } from "./tools/publish.js";
import { registerStatusTools } from "./tools/status.js";
import { registerMaintenanceTools } from "./tools/maintenance.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

const server = new McpServer({
  name: "artshow-catalog",
  version: "0.2.0",
});

async function main() {
  const config = loadConfig();
  const db = openDb(config);
  assertSchema(db);
  const ctx = new ServerContext(config, db);

  registerArtworkTools(server, ctx);
  registerClassifierTools(server, ctx);
  registerPublishTools(server, ctx);
  registerStatusTools(server, ctx);
  registerMaintenanceTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `artshow-mcp connected (db: ${config.dbPath}, site: ${config.siteArtworkJsonPath}, ` +
      `r2 bucket: ${config.r2.bucket || "(not configured)"}, credentials: ${config.hasR2Credentials ? "found" : "MISSING"})`,
  );
}

main().catch((err) => {
  console.error("artshow-mcp fatal error:", err);
  process.exit(1);
});
