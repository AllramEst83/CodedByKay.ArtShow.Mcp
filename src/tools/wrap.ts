import { errorResult } from "../lib/format.js";
import { ToolError } from "../lib/errors.js";

/** Wraps a tool handler so a thrown ToolError (expected, user-facing) or any other Error becomes
 * a proper MCP error result instead of an unhandled rejection killing the server. Every
 * server.registerTool callback in tools/*.ts is wrapped with this. */
export function guarded<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult> | TResult,
): (...args: TArgs) => Promise<TResult | ReturnType<typeof errorResult>> {
  return async (...args: TArgs) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ToolError) return errorResult(err.message, err.data);
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message);
    }
  };
}
