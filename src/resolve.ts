import type { RepositoryEntry, WorkspaceContext } from "./types.ts";

export const DEFAULT_HOST = "https://github.com";

/** Default host as a bare hostname (no protocol), for string comparisons. */
export const BARE_DEFAULT_HOST = DEFAULT_HOST.replace(/^https?:\/\//, "");

/** Owner/org names: letters, digits, hyphens only (GitHub orgs forbid dots). */
const VALID_OWNER_REGEX = /^[a-zA-Z0-9-]+$/;

/** Repo names: letters, digits, hyphens, dots, and underscores — matching GitHub's rules. */
const VALID_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

export interface Repository {
  host?: string;
  owner?: string;
  name: string;
  url?: string;
}

/** Throw if the value is empty or contains invalid characters. */
function assertValidOwner(
  value: string | undefined,
): string {
  if (!value || !VALID_OWNER_REGEX.test(value)) {
    throw new Error(`Invalid repository owner: '${value}'`);
  }
  return value;
}

/** Throw if the value is empty, contains invalid characters, or is a path traversal segment. */
function assertValidName(value: string | undefined): string {
  if (!value || !VALID_NAME_REGEX.test(value)) {
    throw new Error(`Invalid repository name: '${value}'`);
  }
  if (value === "." || value === ".." || value.includes("..")) {
    throw new Error(`Invalid repository name: '${value}'`);
  }
  return value;
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

  const name = assertValidName(repo.name);

  // Explicit URL bypasses host/owner resolution.
  if (repo.url) {
    return { name, url: repo.url };
  }

  const owner = assertValidOwner(repo.owner ?? workspace.owner);
  const host = normalizeHost(repo.host ?? workspace.host);

  return {
    name,
    url: `${host}/${owner}/${name}`,
  };
}
