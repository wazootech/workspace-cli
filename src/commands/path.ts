import { join } from "@std/path";
import { type ManifestPaths, resolveRepositoryPath } from "@/manifest.ts";
import type { CliOptions } from "@/shared.ts";
import type { RepositoryEntry, WorkspaceManifest } from "@/types.ts";

/**
 * Match a query against repository names: exact match first, then
 * case-insensitive substring. Returns the matched entries.
 */
function matchRepos(
  query: string,
  repos: RepositoryEntry[],
): RepositoryEntry[] {
  // Exact match (case-insensitive).
  const exact = repos.filter(
    (r) => r.name.toLowerCase() === query.toLowerCase(),
  );
  if (exact.length > 0) {
    return exact;
  }

  // Substring match (case-insensitive).
  const lower = query.toLowerCase();
  return repos.filter((r) => r.name.toLowerCase().includes(lower));
}

export interface PathResult {
  name: string;
  path: string;
  workspace?: string;
}

/**
 * Resolve a query to one or more path results. Does not require the checkout
 * to exist — paths are derived from the manifest.
 */
export function resolvePaths(
  query: string,
  repos: RepositoryEntry[],
  paths: ManifestPaths,
  opts: { feature?: string },
): PathResult[] {
  const matched = matchRepos(query, repos);
  return matched.map((repo) => {
    const basePath = resolveRepositoryPath(repo, paths);
    const finalPath = opts.feature
      ? join(paths.worktreesDirectory, repo.name, opts.feature)
      : basePath;
    const result: PathResult = { name: repo.name, path: finalPath };
    if (repo.workspace) {
      result.workspace = repo.workspace;
    }
    return result;
  });
}

export function run(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
): number {
  const query = opts.positional[0];
  if (!query) {
    console.error(
      "Usage: wspace path <query> [--feature <name>] [--workspace <name>] [--json]",
    );
    return 2;
  }

  const repos = opts.workspace
    ? manifest.repositories.filter((r) => r.workspace === opts.workspace)
    : manifest.repositories;

  // Extract --feature from positional args (feature is positional[1]).
  const feature = opts.positional[1];
  const results = resolvePaths(query, repos, paths, { feature });

  if (results.length === 0) {
    console.error(`No repository matching "${query}"`);
    return 1;
  }

  if (results.length > 1) {
    console.error(`Ambiguous query "${query}" — multiple matches:`);
    for (const r of results) {
      console.error(`  ${r.name}${r.workspace ? ` (${r.workspace})` : ""}`);
    }
    return 1;
  }

  // Single match — print path to stdout.
  const result = results[0];
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.path);
  }
  return 0;
}
