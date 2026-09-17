/**
 * Byte-for-byte reimplementation of what CodedByKay.ArtShow.CLI's
 * `JsonSerializer.Serialize(items, new JsonSerializerOptions { WriteIndented = true })` writes
 * for `data/artwork.json` — this server and the CLI must both be able to publish that file
 * without every alternate run rewriting the whole thing (see plan.md "publish parity"). Verified
 * byte-for-byte against the live file via test/publishing.test.ts before this was trusted.
 *
 * Confirmed behavior (System.Text.Json defaults, WriteIndented):
 * - CRLF line endings ("\r\n", .NET's Environment.NewLine on Windows), 2-space indent per level,
 *   no trailing newline after the final "]".
 * - Comma placed at the end of the previous line; last item in an array/object gets no comma.
 * - Empty array/object collapses to "[]" / "{}" with no internal whitespace.
 * - String escaping (JavaScriptEncoder.Default, the framework default — conservative/HTML-safe):
 *     " and \        -> \" and \\  (required by JSON)
 *     backspace/tab/LF/FF/CR -> \b \t \n \f \r
 *     other control chars (0x00-0x1F) -> \u00XX
 *     < > & '        -> < > & ' (HTML-sensitive, escaped even though JSON
 *                        doesn't require it)
 *     anything above 0x7E (non-ASCII, plus DEL) -> \uXXXX, uppercase hex, surrogate pairs written
 *                        as two \uXXXX units (JS strings are UTF-16 same as .NET, so iterating
 *                        UTF-16 code units instead of code points matches its behavior exactly)
 *   Printable ASCII 0x20-0x7E other than the above stays literal — notably "/" is NOT escaped.
 */

export type JVal = string | null | JVal[] | OrderedObject;
export interface OrderedObject {
  entries: [string, JVal][];
}

export function obj(entries: [string, JVal][]): OrderedObject {
  return { entries };
}

const NAMED_ESCAPES: Record<number, string> = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
  0x22: '\\"',
  0x5c: "\\\\",
};

// HTML-sensitive ASCII characters JavaScriptEncoder.Default escapes even though bare JSON
// doesn't require it — this is what produces & for "&" and ' for "'" in the real file.
const HTML_SENSITIVE = new Set([0x26, 0x27, 0x3c, 0x3e]); // & ' < >

function hex4Upper(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, "0");
}

export function escapeDotnetJsonString(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const named = NAMED_ESCAPES[code];
    if (named) {
      out += named;
    } else if (code < 0x20 || code > 0x7e || HTML_SENSITIVE.has(code)) {
      out += `\\u${hex4Upper(code)}`;
    } else {
      out += value[i];
    }
  }
  return out;
}

function writeValue(v: JVal, depth: number): string {
  if (v === null) return "null";
  if (typeof v === "string") return `"${escapeDotnetJsonString(v)}"`;

  const pad = "  ".repeat(depth);
  const childPad = "  ".repeat(depth + 1);

  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const items = v.map((item) => childPad + writeValue(item, depth + 1)).join(",\r\n");
    return `[\r\n${items}\r\n${pad}]`;
  }

  if (v.entries.length === 0) return "{}";
  const items = v.entries
    .map(([k, val]) => `${childPad}"${escapeDotnetJsonString(k)}": ${writeValue(val, depth + 1)}`)
    .join(",\r\n");
  return `{\r\n${items}\r\n${pad}}`;
}

/** Serializes a top-level array the same way `JsonSerializer.Serialize(list, { WriteIndented: true })`
 * does — no trailing newline, CRLF throughout. */
export function serializeDotnetJson(items: JVal[]): string {
  return writeValue(items, 0);
}
