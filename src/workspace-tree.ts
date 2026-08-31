import type {
  RepositoryEntry,
  ResolvedWorkspace,
  WorkspaceConflict,
  WorkspaceManifest,
} from "./types.ts";
import { manifestPaths, resolveRepositoryPath } from "./manifest-paths.ts";

/**
 * Resolve the workspace tree: flatten the repo list from the manifest with
 * workspace attribution. Each repository's path is resolved against the
 * workspace's configured directories.
 */
export function resolveWorkspaceTree(
  manifest: WorkspaceManifest,
  manifestPath: string,
): ResolvedWorkspace {
  const paths = manifestPaths(manifest, manifestPath);
  const repositories = manifest.repositories.map((repo) => ({
    ...repo,
    workspace: undefined as string | undefined,
    resolvedPath: resolveRepositoryPath(repo, paths),
  }));
  return { root: manifest, repositories };
}

/**
 * Detect conflicts: repos claimed by more than one workspace.
 */
export function detectConflicts(
  resolved: ResolvedWorkspace,
): WorkspaceConflict[] {
  const claims = new Map<string, string[]>();
  for (const repo of resolved.repositories) {
    const wsName = repo.workspace ?? "(root)";
    const existing = claims.get(repo.name) ?? [];
    existing.push(wsName);
    claims.set(repo.name, existing);
  }
  const conflicts: WorkspaceConflict[] = [];
  for (const [repoName, claimedBy] of claims) {
    if (claimedBy.length > 1) {
      conflicts.push({ repoName, claimedBy });
    }
  }
  return conflicts;
}

/**
 * List sub-workspaces with their repo counts and manifest paths.
 */
export function listWorkspaces(
  resolved: ResolvedWorkspace,
): { name: string; repos: number; child: boolean }[] {
  const result: { name: string; repos: number; child: boolean }[] = [];

  // Root workspace (repos without workspace attribution).
  const rootRepos = resolved.repositories.filter((r) => !r.workspace);
  if (rootRepos.length > 0) {
    result.push({ name: "(root)", repos: rootRepos.length, child: false });
  }

  // Group repos by workspace name.
  const byWorkspace = new Map<string, RepositoryEntry[]>();
  for (const repo of resolved.repositories) {
    if (repo.workspace) {
      const existing = byWorkspace.get(repo.workspace) ?? [];
      existing.push(repo);
      byWorkspace.set(repo.workspace, existing);
    }
  }

  for (const [name, repos] of byWorkspace) {
    result.push({ name, repos: repos.length, child: true });
  }

  return result;
}
