export const DEFAULT_HOST = "https://github.com";

/** Default host as a bare hostname (no protocol), for string comparisons. */
export const BARE_DEFAULT_HOST = DEFAULT_HOST.replace(/^https?:\/\//, "");

const VALID_SEGMENT_REGEX = /^[a-zA-Z0-9-]+$/;

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

/** Throw if the value is empty or contains invalid characters. */
function assertValidSegment(
  value: string | undefined,
  label: string,
): string {
  if (!value || !VALID_SEGMENT_REGEX.test(value)) {
    throw new Error(`Invalid ${label}: '${value}'`);
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
 * producing a name and full URL.
 */
export function resolveRepository(
  workspace: WorkspaceContext,
  repository: string | Repository,
): ResolvedRepository {
  const repo = typeof repository === "string"
    ? parseRepository(repository)
    : repository;

  const name = assertValidSegment(repo.name, "repository name");

  // Explicit URL bypasses host/owner resolution.
  if (repo.url) {
    return { name, url: repo.url };
  }

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

/** Resolve all repositories in a workspace against its host and owner. */
export function resolveWorkspace(workspace: Workspace): ResolvedWorkspace {
  return {
    host: workspace.host,
    owner: workspace.owner,
    repositories: workspace.repositories.map((repo) =>
      resolveRepository(workspace, repo)
    ),
  };
}
