import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../lib/slug.js";
import { isValidIsoDate, yearOf } from "../lib/dates.js";
import { levenshtein, closestMatch, closeEnoughThreshold } from "../lib/fuzzy.js";
import { parseYouTubeId } from "../lib/youtube.js";

test("slugify matches CodedByKay.ArtShow.CLI's AddFlow.Slugify", () => {
  assert.equal(slugify("Mom & Grandma"), "mom-grandma");
  assert.equal(slugify("Walking vehicle (1800th century)"), "walking-vehicle-1800th-century");
  assert.equal(slugify("  leading/trailing  "), "leading-trailing");
  assert.equal(slugify("ALLCAPS"), "allcaps");
});

test("isValidIsoDate rejects malformed and non-existent calendar dates", () => {
  assert.equal(isValidIsoDate("2026-09-17"), true);
  assert.equal(isValidIsoDate("2026-02-29"), false); // 2026 is not a leap year
  assert.equal(isValidIsoDate("2024-02-29"), true); // 2024 is
  assert.equal(isValidIsoDate("2026-13-01"), false);
  assert.equal(isValidIsoDate("09-17-2026"), false);
  assert.equal(isValidIsoDate("not-a-date"), false);
});

test("yearOf reads the year prefix", () => {
  assert.equal(yearOf("2009-03-22"), "2009");
});

test("levenshtein is case-insensitive and symmetric", () => {
  assert.equal(levenshtein("watercolor", "watercolor"), 0);
  assert.equal(levenshtein("Watercolor", "watercolor"), 0);
  assert.equal(levenshtein("watercolour", "watercolor"), 1);
  assert.equal(levenshtein("kitten", "sitting"), 3);
});

test("closestMatch finds near-duplicates but not unrelated values", () => {
  const pool = [{ Name: "watercolor" }, { Name: "pencil" }, { Name: "ink" }];
  const near = closestMatch("watercolour", pool, (c) => c.Name);
  assert.equal(near?.name, "watercolor");
  assert.equal(near?.exact, false);

  const exact = closestMatch("Pencil", pool, (c) => c.Name);
  assert.equal(exact?.exact, true);
  assert.equal(exact?.name, "pencil");

  const unrelated = closestMatch("photography", pool, (c) => c.Name);
  assert.equal(unrelated, null);
});

test("closeEnoughThreshold scales with length", () => {
  assert.equal(closeEnoughThreshold(3), 1);
  assert.equal(closeEnoughThreshold(11), 3);
});

test("parseYouTubeId matches CodedByKay.ArtShow.CLI's YouTubeIdParser", () => {
  assert.equal(parseYouTubeId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(parseYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(parseYouTubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(parseYouTubeId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(parseYouTubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(parseYouTubeId("  dQw4w9WgXcQ  "), "dQw4w9WgXcQ");
  assert.equal(parseYouTubeId("not a url or id"), null);
});
