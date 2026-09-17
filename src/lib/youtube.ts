// Mirrors CodedByKay.ArtShow.CLI/Menus/YouTubeIdParser.cs exactly — same two patterns, same
// precedence (bare 11-char id checked first).
const BARE_ID = /^[A-Za-z0-9_-]{11}$/;
const URL_ID = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/;

export function parseYouTubeId(input: string): string | null {
  const trimmed = input.trim();
  if (BARE_ID.test(trimmed)) return trimmed;
  const match = URL_ID.exec(trimmed);
  return match ? match[1] : null;
}
