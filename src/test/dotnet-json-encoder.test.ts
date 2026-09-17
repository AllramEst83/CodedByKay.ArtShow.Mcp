import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { obj, serializeDotnetJson, type JVal } from "../publishing/dotnet-json-encoder.js";

/** Converts a plain value from JSON.parse back into our ordered JVal — JS preserves string-key
 * insertion order from JSON.parse, so this round-trip is order-faithful. */
function toJVal(v: unknown): JVal {
  if (v === null) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(toJVal);
  if (typeof v === "object") return obj(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, toJVal(val)]));
  throw new Error(`dotnet-json-encoder round-trip test: unsupported JSON value type ${typeof v}`);
}

// Isolates the encoder's byte-fidelity from whether the live DB and the live site file currently
// agree (they won't, while Kay is actively adding artwork through the CLI in parallel with this
// build — see test/publishing.test.ts for that comparison instead). This test only asks: "does
// our writer reproduce exactly the bytes System.Text.Json already wrote?" — parse what's on disk
// right now, re-encode it with our writer, and the two texts must match exactly.
test("dotnet-json-encoder reproduces the live artwork.json byte-for-byte on a pure parse+re-encode round trip", () => {
  const config = loadConfig();
  if (!existsSync(config.siteArtworkJsonPath)) {
    console.error(`skipping: ${config.siteArtworkJsonPath} not found on this machine`);
    return;
  }

  const original = readFileSync(config.siteArtworkJsonPath, "utf8");
  const parsed = JSON.parse(original) as unknown[];
  const reEncoded = serializeDotnetJson(parsed.map(toJVal));

  assert.equal(reEncoded, original);
});

test("dotnet-json-encoder escaping matches System.Text.Json's JavaScriptEncoder.Default", () => {
  const cases: [string, string][] = [
    ["Mom & Grandma", '"Mom \\u0026 Grandma"'],
    ["it's", '"it\\u0027s"'],
    ["Air — School Project", '"Air \\u2014 School Project"'],
    ["Fine liner äö", '"Fine liner \\u00E4\\u00F6"'],
    ["<script>", '"\\u003Cscript\\u003E"'],
    ['quote " backslash \\', '"quote \\" backslash \\\\"'],
    ["tab\tnewline\ncr\rbs\bff\f", '"tab\\tnewline\\ncr\\rbs\\bff\\f"'],
    ["plain ascii/slash:ok", '"plain ascii/slash:ok"'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(serializeDotnetJson([input]), `[\r\n  ${expected}\r\n]`);
  }
});

test("dotnet-json-encoder collapses empty arrays/objects and omits a trailing newline", () => {
  assert.equal(serializeDotnetJson([]), "[]");
  assert.equal(serializeDotnetJson([obj([["groups", []]])]), '[\r\n  {\r\n    "groups": []\r\n  }\r\n]');
  assert.ok(!serializeDotnetJson(["x"]).endsWith("\n\n"));
  assert.equal(serializeDotnetJson(["x"]).slice(-1), "]");
});
