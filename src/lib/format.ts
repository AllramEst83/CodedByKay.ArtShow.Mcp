// Mirrors CodedByKay.ArtShow.CLI/Menus/StatusFlow.cs FormatBytes.
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Every tool result: JSON text (for a human/agent reading the transcript) plus the same value as
 * structuredContent (for a client that wants to consume it programmatically). Use this instead of
 * hand-building `{ content: [...] }` so both stay in sync.
 */
export function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function errorResult(message: string, data?: unknown) {
  return {
    content: [{ type: "text" as const, text: data === undefined ? message : `${message}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: (data === undefined ? { error: message } : { error: message, data }) as Record<string, unknown>,
    isError: true,
  };
}
