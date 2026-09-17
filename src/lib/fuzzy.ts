/** Classic Levenshtein edit distance, case-insensitive. */
export function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 0;
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * How many edits are "close enough" to flag as a likely duplicate, scaled to string length so
 * short values ("ink" vs "ink ") aren't over-tolerant and long ones ("watercolour" vs
 * "watercolor") aren't under-tolerant. Exact case-insensitive matches always have distance 0 and
 * are handled by the caller before this threshold matters.
 */
export function closeEnoughThreshold(length: number): number {
  return Math.max(1, Math.floor(length * 0.34));
}

export interface ClosestCandidate<T> {
  item: T;
  name: string;
  distance: number;
  exact: boolean;
}

/** Finds the closest name to `candidate` among `pool` (by `nameOf`), or null if nothing is close. */
export function closestMatch<T>(
  candidate: string,
  pool: readonly T[],
  nameOf: (item: T) => string,
): ClosestCandidate<T> | null {
  let best: ClosestCandidate<T> | null = null;
  for (const item of pool) {
    const name = nameOf(item);
    const distance = levenshtein(candidate, name);
    if (best === null || distance < best.distance) {
      best = { item, name, distance, exact: distance === 0 };
    }
    if (best.distance === 0) break;
  }
  if (best === null) return null;
  if (best.exact) return best;
  return best.distance <= closeEnoughThreshold(Math.max(candidate.length, best.name.length)) ? best : null;
}
