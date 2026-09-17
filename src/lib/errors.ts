/**
 * Thrown by tool implementations for an expected, user-facing failure (bad input, missing
 * classifiers, R2 not configured, etc). Tool wrappers in tools/*.ts catch this and turn it into
 * an MCP error result instead of letting it surface as an unhandled exception. `data` is attached
 * as structuredContent so an agent can act on it programmatically (e.g. the classifier vocabulary
 * on a "missing classifiers" error) instead of re-parsing the message text.
 */
export class ToolError extends Error {
  readonly data?: unknown;

  constructor(message: string, data?: unknown) {
    super(message);
    this.name = "ToolError";
    this.data = data;
  }
}
