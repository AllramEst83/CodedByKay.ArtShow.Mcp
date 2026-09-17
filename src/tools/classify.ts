import type { DatabaseSync } from "node:sqlite";
import type { ClassifierKind } from "../lib/types.js";
import { closestMatch } from "../lib/fuzzy.js";
import { listClassifierRows, listClassifiersWithUsage } from "../db/classifiers.js";
import { ToolError } from "../lib/errors.js";

export type ClassifierMode = "strict" | "lenient";
export type OnMissingClassifiers = "error" | "warn" | "allow";

export interface ResolvedValue {
  value: string;
  isNew: boolean;
}

/**
 * Resolves one raw classifier value (e.g. a category the agent wrote) against the existing
 * vocabulary of that kind. In "lenient" mode (default, matches the CLI's own auto-add behavior)
 * an unrecognized value is accepted as-is and flagged `isNew` for the caller to report — the
 * actual Classifiers row gets created by ensureClassifier() inside createArtworkRow/updateArtworkRow.
 * In "strict" mode an unrecognized value is rejected: if something close already exists
 * ("watercolour" vs "watercolor") the error suggests it by name instead of letting a near-duplicate
 * spelling become a second classifier; otherwise it says so plainly and points at list_classifiers.
 */
export function resolveClassifierValue(
  db: DatabaseSync,
  kind: ClassifierKind,
  rawValue: string,
  mode: ClassifierMode,
): ResolvedValue {
  const trimmed = rawValue.trim();
  const pool = listClassifierRows(db, { kind });
  const exact = pool.find((c) => c.Name.toLowerCase() === trimmed.toLowerCase());
  if (exact) return { value: exact.Name, isNew: false };

  if (mode === "lenient") return { value: trimmed, isNew: true };

  const near = closestMatch(trimmed, pool, (c) => c.Name);
  if (near) {
    throw new ToolError(
      `${kind} "${trimmed}" isn't in the vocabulary, but "${near.name}" is close — did you mean that? ` +
        `Pass classifierMode: "lenient" to create "${trimmed}" as a new ${kind} anyway, or use "${near.name}".`,
    );
  }
  throw new ToolError(
    `${kind} "${trimmed}" isn't in the vocabulary and nothing close was found. Call list_classifiers to see ` +
      `what's established, or pass classifierMode: "lenient" to create it as a new ${kind}.`,
  );
}

export interface ResolvedClassifiers {
  category?: string;
  medium?: string;
  tags?: string[];
  groups?: string[];
  newlyCreated: { kind: ClassifierKind; name: string }[];
}

export function resolveClassifiers(
  db: DatabaseSync,
  input: { category?: string; medium?: string; tags?: string[]; groups?: string[] },
  mode: ClassifierMode,
): ResolvedClassifiers {
  const newlyCreated: { kind: ClassifierKind; name: string }[] = [];
  const track = (kind: ClassifierKind, resolved: ResolvedValue): string => {
    if (resolved.isNew) newlyCreated.push({ kind, name: resolved.value });
    return resolved.value;
  };

  const result: ResolvedClassifiers = { newlyCreated };
  if (input.category !== undefined) result.category = track("Category", resolveClassifierValue(db, "Category", input.category, mode));
  if (input.medium !== undefined) result.medium = track("Medium", resolveClassifierValue(db, "Medium", input.medium, mode));
  if (input.tags !== undefined) result.tags = input.tags.map((t) => track("Tag", resolveClassifierValue(db, "Tag", t, mode)));
  if (input.groups !== undefined) result.groups = input.groups.map((g) => track("Group", resolveClassifierValue(db, "Group", g, mode)));
  return result;
}

export function hasNoClassifiers(input: { category?: string; medium?: string; tags?: string[]; groups?: string[] }): boolean {
  return (
    !input.category &&
    !input.medium &&
    (input.tags === undefined || input.tags.length === 0) &&
    (input.groups === undefined || input.groups.length === 0)
  );
}

/** The vocabulary payload attached to a "missing classifiers" error, so an agent that hits it can
 * immediately look at the image and retry with real values instead of making a second round trip
 * to list_classifiers first. */
export function vocabularySnapshot(db: DatabaseSync) {
  return {
    category: listClassifiersWithUsage(db, { kind: "Category" }),
    medium: listClassifiersWithUsage(db, { kind: "Medium" }),
    tag: listClassifiersWithUsage(db, { kind: "Tag" }),
    group: listClassifiersWithUsage(db, { kind: "Group" }),
  };
}

export function checkMissingClassifiers(
  db: DatabaseSync,
  input: { category?: string; medium?: string; tags?: string[]; groups?: string[] },
  onMissing: OnMissingClassifiers,
  itemLabel: string,
): { warning?: string } {
  if (!hasNoClassifiers(input)) return {};
  if (onMissing === "allow") return {};

  const message =
    `${itemLabel} has no category, medium, tags, or groups. Look at the image and classify it using ` +
    `the existing vocabulary below (prefer an established value; only introduce a new one if nothing fits).`;

  if (onMissing === "warn") return { warning: message };
  throw new ToolError(message, vocabularySnapshot(db));
}
