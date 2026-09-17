interface ArtworkJsonItemLike {
  id: string;
  [key: string]: unknown;
}

export interface ModifiedItem {
  id: string;
  title: string;
  changedFields: string[];
}

export interface PublishDiff {
  added: { id: string; title: string }[];
  removed: { id: string; title: string }[];
  modified: ModifiedItem[];
  unchangedCount: number;
}

function byId(items: ArtworkJsonItemLike[]): Map<string, ArtworkJsonItemLike> {
  return new Map(items.map((i) => [i.id, i]));
}

function fieldsDiffer(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** Compares two already-parsed artwork.json contents (old file on disk vs the new text this
 * publish is about to write) and reports what actually changed, so a publish's result tells Kay
 * something more useful than "wrote N items." Comparison is by parsed value, not by text, so
 * re-running publish with nothing changed reports a clean diff even though the bytes were
 * rewritten (System.Text.Json/this encoder aren't guaranteed to be idempotent byte-for-byte
 * across .NET/Node versions long-term — the parity target is "no diff a reviewer would notice"). */
export function diffArtworkJson(oldItems: ArtworkJsonItemLike[], newItems: ArtworkJsonItemLike[]): PublishDiff {
  const oldMap = byId(oldItems);
  const newMap = byId(newItems);

  const added: PublishDiff["added"] = [];
  const removed: PublishDiff["removed"] = [];
  const modified: ModifiedItem[] = [];
  let unchangedCount = 0;

  for (const [id, item] of newMap) {
    if (!oldMap.has(id)) {
      added.push({ id, title: String(item.title ?? "") });
    }
  }
  for (const [id, item] of oldMap) {
    if (!newMap.has(id)) {
      removed.push({ id, title: String(item.title ?? "") });
    }
  }
  for (const [id, newItem] of newMap) {
    const oldItem = oldMap.get(id);
    if (!oldItem) continue;
    const changedFields = Object.keys(newItem).filter((key) => fieldsDiffer(oldItem[key], newItem[key]));
    if (changedFields.length > 0) {
      modified.push({ id, title: String(newItem.title ?? ""), changedFields });
    } else {
      unchangedCount++;
    }
  }

  return { added, removed, modified, unchangedCount };
}
