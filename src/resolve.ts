/**
 * Pure resolution logic for workspace repository entries.
 *
 * Given a workspace context (host, owner) and a raw repository entry
 * (string or object), resolve it to a concrete name and URL. No side
 * effects, no filesystem access, no manifest awareness.
 */

export const DEFAULT_HOST = "https://github.com";
const VALID_SEGMENT_REGEX = /^[a-zA-Z0-9._-]+$/;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Workspace context used for resolution fallbacks. */
export interface WorkspaceContext {
  host?: string;
  owner?: string;
}

export interface Workspace extends WorkspaceContext {
  repositories: Array<string | Repository>;
}

export interface Repository {
  host?: string;
  owner?: string;
  name: string;
  url?: string;
}

export interface ResolvedRepository {
  name: string;
  url: string;
}

export interface ResolvedWorkspace {
  host?: string;
  owner?: string;
  repositories: ResolvedRepository[];
}

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------

/** Single validation primitive for host/name segments. */
function assertValidSegment(
  value: string | undefined,
  label: string,
): string {
  if (!value || !VALID_SEGMENT_REGEX.test(value)) {
    throw new Error(`Invalid ${label}: '${value}'`);
  }
  return value;
}

/**
 * Pure structural parser — zero validation side-effects.
 *
 * Parses "owner/name" into a Repository object. If there is no `/`, the
 * string is assumed to be a bare repository name.
 */
export function parseRepository(repository: string): Repository {
  const parts = repository.split("/");
  if (parts.length > 2 || parts.some((p) => !p)) {
    throw new Error(`Unable to parse repository string: '${repository}'`);
  }
  return parts.length === 2
    ? { owner: parts[0], name: parts[1] }
    : { name: parts[0] };
}

/** Normalize a host to a full URL (adds https:// if missing). */
function normalizeHost(host: string = DEFAULT_HOST): string {
  return host.includes("://") ? host : `https://${host}`;
}

// -----------------------------------------------------------------------------
// Main Resolvers
// -----------------------------------------------------------------------------

/**
 * Resolve a single repository entry to a concrete name and URL.
 *
 * Resolution follows a staged pipeline:
 * 1. Normalize input type (string → Repository object via parseRepository)
 * 2. Validate name early (required regardless of URL presence)
 * 3. Escape hatch for explicit custom URLs
 * 4. Cascading host/owner fallbacks + boundary validation
 */
export function resolveRepository(
  workspace: WorkspaceContext,
  repository: string | Repository,
): ResolvedRepository {
  // Stage 1: Normalize input type
  const repo = typeof repository === "string"
    ? parseRepository(repository)
    : repository;

  // Stage 2: Validate name early (required regardless of URL presence)
  const name = assertValidSegment(repo.name, "repository name");

  // Stage 3: Escape hatch for explicit custom URLs
  if (repo.url) {
    return { name, url: repo.url };
  }

  // Stage 4: Cascading fallbacks + boundary validation
  const owner = assertValidSegment(
    repo.owner ?? workspace.owner,
    "repository owner",
  );
  const host = normalizeHost(repo.host ?? workspace.host);

  return {
    name,
    url: `${host}/${owner}/${name}`,
  };
}

/**
 * Resolve all repositories in a workspace.
 */
export function resolveWorkspace(workspace: Workspace): ResolvedWorkspace {
  return {
    host: workspace.host,
    owner: workspace.owner,
    repositories: workspace.repositories.map((repo) =>
      resolveRepository(workspace, repo)
    ),
  };
}
