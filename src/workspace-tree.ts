import { exists } from "@std/fs";
import { join, normalize, resolve } from "@std/path";
import { findExistingManifest } from "./manifest-discovery.ts";
import { loadManifest } from "./manifest-normalize.ts";
import { manifestPaths, resolveRepositoryPath } from "./manifest-paths.ts";
import type {
  RepositoryEntry,
  ResolvedWorkspace,
  WorkspaceConflict,
  WorkspaceManifest,
} from "./types.ts";

/**
 * Resolve declared workspace repositories and their child manifests. A
 * missing workspace checkout is retained as a normal missing repository so
 * `install` can clone it; an existing checkout must contain a valid manifest.
 */
export async function resolveWorkspaceTree(
  manifest: WorkspaceManifest,
  manifestPath: string,
): Promise<ResolvedWorkspace> {
  const children = new Map<string, WorkspaceManifest>();
  const workspaceEntries: RepositoryEntry[] = [];
  const repositories: RepositoryEntry[] = [];
  const visitedManifests = new Set<string>();
  const declaredWorkspaceNames = new Set<string>();

  await collect(manifest, manifestPath, undefined);

  return { root: manifest, children, workspaceEntries, repositories };

  async function collect(
    current: WorkspaceManifest,
    currentPath: string,
    parentWorkspace: string | undefined,
  ): Promise<void> {
    const currentManifest = normalize(resolve(currentPath));
    if (visitedManifests.has(currentManifest)) {
      throw new Error(
        `Circular workspace manifest reference: ${currentManifest}`,
      );
    }
    visitedManifests.add(currentManifest);

    const paths = manifestPaths(current, currentPath);
    for (const repository of current.repositories) {
      repositories.push({
        ...repository,
        workspace: parentWorkspace,
        resolvedPath: resolveRepositoryPath(repository, paths),
      });
    }

    for (const declared of current.workspaces ?? []) {
      const workspace = {
        ...declared,
        isWorkspace: true,
        workspace: parentWorkspace,
        resolvedPath: resolveRepositoryPath(declared, paths),
      };
      workspaceEntries.push(workspace);
      repositories.push(workspace);
      if (declaredWorkspaceNames.has(workspace.name)) {
        throw new Error(`Duplicate workspace name: ${workspace.name}`);
      }
      declaredWorkspaceNames.add(workspace.name);

      const checkoutPath = workspace.resolvedPath!;
      if (
        await exists(checkoutPath) &&
        !(await exists(join(checkoutPath, ".git")))
      ) {
        throw new Error(
          `Workspace repository "${workspace.name}" at ${checkoutPath} is not a Git repository`,
        );
      }
      const childManifestPath = await findExistingManifest(checkoutPath);
      if (!childManifestPath) {
        if (await exists(checkoutPath)) {
          throw new Error(
            `Workspace repository "${workspace.name}" at ${checkoutPath} does not contain a workspace.json manifest`,
          );
        }
        continue;
      }

      const childPath = normalize(resolve(childManifestPath));
      if (children.has(workspace.name)) {
        throw new Error(`Duplicate workspace name: ${workspace.name}`);
      }
      const child = await loadManifest(childPath);
      children.set(workspace.name, child);
      await collect(child, childPath, workspace.name);
    }
  }
}

/** Detect repository names claimed more than once in the resolved tree. */
export function detectConflicts(
  resolved: ResolvedWorkspace,
): WorkspaceConflict[] {
  const claims = new Map<string, string[]>();
  for (const repo of resolved.repositories) {
    const owner = repo.workspace ?? "(root)";
    const existing = claims.get(repo.name) ?? [];
    existing.push(owner);
    claims.set(repo.name, existing);
  }
  return [...claims.entries()]
    .filter(([, claimedBy]) => claimedBy.length > 1)
    .map(([repoName, claimedBy]) => ({ repoName, claimedBy }));
}

/** List the root workspace and every declared child workspace. */
export function listWorkspaces(
  resolved: ResolvedWorkspace,
): { name: string; repos: number; child: boolean }[] {
  const rootRepos = resolved.repositories.filter((repo) => !repo.workspace);
  const result: { name: string; repos: number; child: boolean }[] = [];
  if (rootRepos.length > 0) {
    result.push({ name: "(root)", repos: rootRepos.length, child: false });
  }

  const entries = resolved.workspaceEntries ?? [];
  if (entries.length > 0) {
    for (const workspace of entries) {
      const repos = resolved.repositories.filter(
        (repo) => repo.workspace === workspace.name,
      ).length;
      result.push({ name: workspace.name, repos, child: true });
    }
  } else {
    const byWorkspace = new Map<string, number>();
    for (const repo of resolved.repositories) {
      if (repo.workspace) {
        byWorkspace.set(
          repo.workspace,
          (byWorkspace.get(repo.workspace) ?? 0) + 1,
        );
      }
    }
    for (const [name, repos] of byWorkspace) {
      result.push({ name, repos, child: true });
    }
  }
  return result;
}
