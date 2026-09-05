import { exists } from "@std/fs";
import { join, normalize, resolve } from "@std/path";
import { findExistingManifest } from "./manifest-discovery.ts";
import { loadManifest } from "./manifest-normalize.ts";
import {
  manifestPaths,
  resolveRepositoryPath,
  resolveWorkspacePath,
} from "./manifest-paths.ts";
import type {
  RepositoryEntry,
  ResolvedWorkspace,
  WorkspaceConflict,
  WorkspaceManifest,
} from "./types.ts";

/**
 * Resolve declared workspace repositories and their child manifests. A
 * missing workspace checkout is retained as a normal missing repository so
 * `install` can clone it; an existing checkout without a valid manifest is
 * retained as an error-marked entry so `check`/`install` can report it as a
 * row instead of aborting the whole tree.
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
        resolvedPath: resolveWorkspacePath(declared, paths),
      };
      workspaceEntries.push(workspace);
      repositories.push(workspace);
      if (declaredWorkspaceNames.has(workspace.name)) {
        throw new Error(`Duplicate workspace name: ${workspace.name}`);
      }
      declaredWorkspaceNames.add(workspace.name);

      const checkoutPath = workspace.resolvedPath!;
      const checkoutExists = await exists(checkoutPath);
      if (checkoutExists && !(await exists(join(checkoutPath, ".git")))) {
        workspace.error =
          `Workspace repository "${workspace.name}" at ${checkoutPath} is not a Git repository`;
        continue;
      }
      const childManifestPath = await findExistingManifest(checkoutPath);
      if (!childManifestPath) {
        if (checkoutExists) {
          workspace.error =
            `Workspace repository "${workspace.name}" at ${checkoutPath} does not contain a workspace.json manifest`;
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

/**
 * Detect checkouts that collide on disk: entries resolving to the same path.
 * Same-named repos in different workspaces do not conflict because each
 * workspace has its own checkout directory; entries without a resolved path
 * (hand-built views) fall back to name-based keying.
 */
export function detectConflicts(
  resolved: ResolvedWorkspace,
): WorkspaceConflict[] {
  const claims = new Map<
    string,
    { repoName: string; path: string; claimedBy: string[] }
  >();
  for (const repo of resolved.repositories) {
    const owner = repo.workspace ?? "(root)";
    const key = repo.resolvedPath !== undefined
      ? normalize(resolve(repo.resolvedPath))
      : repo.name;
    const existing = claims.get(key) ?? {
      repoName: repo.name,
      path: key,
      claimedBy: [],
    };
    existing.claimedBy.push(owner);
    claims.set(key, existing);
  }
  return [...claims.entries()]
    .filter(([, claim]) => claim.claimedBy.length > 1)
    .map(([, claim]) => claim);
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
