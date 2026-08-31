import type { RepositoryEntry, WorkspaceContext } from "./types.ts";
import { validateOwnerSegment, validateRepositoryName } from "./names.ts";

export const DEFAULT_HOST = "https://github.com";

/** Default host as a bare hostname (no protocol), for string comparisons. */
export const BARE_DEFAULT_HOST = DEFAULT_HOST.replace(/^https?:\/\//, "");

export interface Repository {
  host?: string;
  owner?: string;
  name: string;
  url?: string;
}

/** Parse a bare or "owner/name" string into a Repository. */
export function parseRepository(repository: string): Repository {
  const parts = repository.split("/");
  if (parts.length > 2 || parts.some((p) => !p)) {
    throw new Error(`Unable to parse repository string: '${repository}'`);
  }
  return parts.length === 2
    ? { owner: parts[0], name: parts[1] }
    : { name: parts[0] };
}

/** Ensure the host has a protocol prefix. */
function normalizeHost(host: string = DEFAULT_HOST): string {
  return host.includes("://") ? host : `https://${host}`;
}

/**
 * Resolve a repository string or object against a workspace context,
 * producing a fully typed RepositoryEntry with name and URL.
 */
export function resolveRepository(
  workspace: WorkspaceContext,
  repository: string | Repository,
): RepositoryEntry {
  const repo = typeof repository === "string"
    ? parseRepository(repository)
    : repository;

  const name = validateRepositoryName(repo.name);

  // Explicit URL bypasses host/owner resolution.
  if (repo.url) {
    return { name, url: repo.url };
  }

  const owner = validateOwnerSegment(repo.owner ?? workspace.owner);
  const host = normalizeHost(repo.host ?? workspace.host);

  return {
    name,
    url: `${host}/${owner}/${name}`,
  };
}
