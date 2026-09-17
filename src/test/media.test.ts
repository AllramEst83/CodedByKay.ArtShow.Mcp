import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { KeyAllocator } from "../media/keys.js";
import { createThumbnail, encodeOriginalAsWebp } from "../media/imaging.js";

test("KeyAllocator appends -2, -3, ... on collision and reserves both keys atomically", () => {
  const allocator = new KeyAllocator([]);
  const first = allocator.allocate("Old Tree", "2026");
  assert.equal(first.originalKey, "originals/2026/old-tree.webp");
  assert.equal(first.thumbKey, "thumbs/2026/old-tree-600w.webp");

  const second = allocator.allocate("Old Tree", "2026");
  assert.equal(second.originalKey, "originals/2026/old-tree-2.webp");
  assert.equal(second.thumbKey, "thumbs/2026/old-tree-2-600w.webp");
});

test("KeyAllocator treats keys already referenced in the catalog as reserved", () => {
  const allocator = new KeyAllocator(["originals/2026/old-tree.webp", "thumbs/2026/old-tree-600w.webp"]);
  const allocated = allocator.allocate("Old Tree", "2026");
  assert.equal(allocated.originalKey, "originals/2026/old-tree-2.webp");
});

test("KeyAllocator falls back to 'untitled' for a title with no slug-able characters", () => {
  const allocator = new KeyAllocator([]);
  const allocated = allocator.allocate("!!!", "2026");
  assert.equal(allocated.slug, "untitled");
});

test("imaging pipeline EXIF-orients, re-encodes as WebP, and never upscales the thumbnail", async () => {
  // A 20x10 image with an EXIF Orientation tag requesting a 90deg rotation — after .rotate()
  // auto-orients, the displayed (and thumbnail) dimensions should be 10x20, not 20x10.
  const source = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#3366cc" } })
    .withMetadata({ orientation: 6 }) // 6 = rotate 90deg CW to display correctly
    .jpeg()
    .toBuffer();

  const original = await encodeOriginalAsWebp(source);
  assert.equal(original.width, 10);
  assert.equal(original.height, 20);
  assert.equal((await sharp(original.buffer).metadata()).format, "webp");

  const thumb = await createThumbnail(source);
  // Source is far smaller than the 600px thumbnail width — withoutEnlargement must keep it as-is.
  assert.equal(thumb.width, 10);
  assert.equal(thumb.height, 20);
});

test("createThumbnail resizes a wide image down to 600px without upscaling", async () => {
  const source = await sharp({ create: { width: 1800, height: 900, channels: 3, background: "#cc6633" } })
    .jpeg()
    .toBuffer();
  const thumb = await createThumbnail(source);
  assert.equal(thumb.width, 600);
  assert.equal(thumb.height, 300);
});
