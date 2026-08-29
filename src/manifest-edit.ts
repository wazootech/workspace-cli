/**
 * Surgical edits to the repositories collection of a workspace manifest.
 * Pure text-in/text-out: functions return the new document text or throw
 * ManifestEditError without side effects.
 */
import { BARE_DEFAULT_HOST, resolveRepository } from "./resolve.ts";

export class ManifestEditError extends Error {}

/** Entry forms accepted by add/remove, mirroring schema v4 authoring. */
export type NewEntry =
  | { kind: "shorthand"; raw: string }
  | { kind: "object"; name: string; url: string };

/** Render an entry as it is written into .json manifests. */
export function formatEntry(entry: NewEntry): string {
  if (entry.kind === "shorthand") {
    return JSON.stringify(entry.raw);
  }
  return `{ "name": ${JSON.stringify(entry.name)}, "url": ${
    JSON.stringify(entry.url)
  } }`;
}

/**
 * Insert an entry into the repositories array of a .json document,
 * returning the rewritten text.
 */
export function addEntry(raw: string, entryText: string): string {
  const doc = JSON.parse(raw);
  if (!Array.isArray(doc.repositories)) {
    throw new ManifestEditError(
      `"repositories" is not an array in this manifest`,
    );
  }
  doc.repositories.push(JSON.parse(entryText));
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Remove the entry whose effective repository name equals `targetName`
 * from a .json document.
 */
export function removeEntry(
  raw: string,
  targetName: string,
  owner?: string,
  host = BARE_DEFAULT_HOST,
): string {
  const doc = JSON.parse(raw);
  if (!Array.isArray(doc.repositories)) {
    throw new ManifestEditError(
      `"repositories" is not an array in this manifest`,
    );
  }
  const idx = doc.repositories.findIndex(
    (entry: unknown) =>
      entry === targetName ||
      (typeof entry === "object" && entry !== null &&
        (entry as Record<string, unknown>).name === targetName) ||
      (typeof entry === "string" &&
        resolvedName(entry, owner, host) === targetName),
  );
  if (idx === -1) {
    throw new ManifestEditError(
      `Repository "${targetName}" not found in manifest`,
    );
  }
  doc.repositories.splice(idx, 1);
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Resolve a shorthand string to its effective repository name. */
function resolvedName(
  shorthand: string,
  owner: string | undefined,
  host: string,
): string {
  try {
    return resolveRepository({ host, owner }, shorthand).name;
  } catch {
    return "";
  }
}
