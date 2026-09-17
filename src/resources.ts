import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "./context.js";
import { vocabularySnapshot } from "./tools/classify.js";

export function registerResources(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    "classifiers",
    "artshow://classifiers",
    {
      title: "Classifier vocabulary",
      description:
        "The catalog's current Category/Medium/Tag/Group vocabulary with usage counts — the same data " +
        "list_classifiers returns, exposed as a resource so a client can pull it into context without a tool call.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(vocabularySnapshot(ctx.db), null, 2) }],
    }),
  );
}
