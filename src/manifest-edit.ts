/**
 * Surgical edits to the repositories and workspaces collections of a
 * workspace manifest.
 */
import { BARE_DEFAULT_HOST, resolveRepository } from "./resolve.ts";

export class ManifestEditError extends Error {}

/** Entry forms accepted by add/remove, mirroring schema v4 authoring. */
export type NewEntry =
  | { kind: "shorthand"; raw: string }
  | { kind: "object"; name: string; url: string };

export type ManifestCollection = "repositories" | "workspaces";

/** Render an entry as it is written into .json manifests. */
export function formatEntry(entry: NewEntry): string {
  if (entry.kind === "shorthand") return JSON.stringify(entry.raw);
  return `{ "name": ${JSON.stringify(entry.name)}, "url": ${
    JSON.stringify(entry.url)
  } }`;
}

/** Insert an entry into a manifest collection. */
export function addEntry(
  raw: string,
  entryText: string,
  collection: ManifestCollection = "repositories",
): string {
  const doc = JSON.parse(raw);
  if (doc[collection] === undefined) {
    if (collection === "repositories") {
      throw new ManifestEditError(
        `"${collection}" is not an array in this manifest`,
      );
    }
    doc[collection] = [];
  }
  if (!Array.isArray(doc[collection])) {
    throw new ManifestEditError(
      `"${collection}" is not an array in this manifest`,
    );
  }
  doc[collection].push(JSON.parse(entryText));
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Remove the entry whose effective repository name equals `targetName`. */
export function removeEntry(
  raw: string,
  targetName: string,
  owner?: string,
  host = BARE_DEFAULT_HOST,
  collection?: ManifestCollection,
): string {
  const doc = JSON.parse(raw);
  const collections = collection
    ? [collection]
    : ["repositories", "workspaces"];
  let foundCollection: ManifestCollection | undefined;
  let index = -1;
  for (const candidate of collections) {
    if (!Array.isArray(doc[candidate])) continue;
    const candidateIndex = doc[candidate].findIndex(
      (entry: unknown) =>
        entry === targetName ||
        (typeof entry === "object" && entry !== null &&
          (entry as Record<string, unknown>).name === targetName) ||
        (typeof entry === "string" &&
          resolvedName(entry, owner, host) === targetName),
    );
    if (candidateIndex >= 0) {
      foundCollection = candidate as ManifestCollection;
      index = candidateIndex;
      break;
    }
  }
  if (!foundCollection || index < 0) {
    throw new ManifestEditError(
      `Repository "${targetName}" not found in manifest`,
    );
  }
  doc[foundCollection].splice(index, 1);
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
