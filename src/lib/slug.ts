// Mirrors CodedByKay.ArtShow.CLI/Menus/AddFlow.cs Slugify — same regex, same behavior:
// lowercase, collapse every run of non a-z0-9 chars into a single '-', trim leading/trailing '-'.
const NON_SLUG_CHARS = /[^a-z0-9]+/g;

export function slugify(title: string): string {
  return title.toLowerCase().replace(NON_SLUG_CHARS, "-").replace(/^-+|-+$/g, "");
}
