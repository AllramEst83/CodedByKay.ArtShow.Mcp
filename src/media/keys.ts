import { slugify } from "../lib/slug.js";

// Mirrors CodedByKay.ArtShow.CLI/Menus/AddFlow.cs's key layout:
//   originals/<year>/<slug>.webp
//   thumbs/<year>/<slug>-600w.webp
// The CLI derives these from slugify(title) + year with NO collision check — two same-year
// artworks with the same title silently clobber each other's R2 object (see
// working-on/mcp-rebuild-plan.md "findings"). Batch adds make that much more likely, so this
// allocator appends "-2", "-3", ... to the slug until both keys are free, checked against every
// key already referenced in the catalog AND every key this allocator has handed out so far in the
// same call (so two new items in one batch can't collide with each other either).
export interface ArtworkKeys {
  originalKey: string;
  thumbKey: string;
  slug: string;
}

export class KeyAllocator {
  private readonly reserved: Set<string>;

  constructor(existingKeys: Iterable<string>) {
    this.reserved = new Set(existingKeys);
  }

  allocate(title: string, year: string): ArtworkKeys {
    const baseSlug = slugify(title) || "untitled";
    let suffix = 0;
    while (true) {
      const slug = suffix === 0 ? baseSlug : `${baseSlug}-${suffix + 1}`;
      const originalKey = `originals/${year}/${slug}.webp`;
      const thumbKey = `thumbs/${year}/${slug}-600w.webp`;
      if (!this.reserved.has(originalKey) && !this.reserved.has(thumbKey)) {
        this.reserved.add(originalKey);
        this.reserved.add(thumbKey);
        return { originalKey, thumbKey, slug };
      }
      suffix++;
    }
  }
}
