import type { GitRunner } from "./git.ts";
import { type ManifestPaths, resolveRepositoryPath } from "./manifest-paths.ts";
import { repoStatus } from "./repo-status.ts";
import { scanStrays } from "./strays.ts";
import { ROOT_LABEL } from "./types.ts";
import type { RepositoryEntry, RepoStatus } from "./types.ts";
import { inspectRepo } from "./repo-inspect.ts";

export { classifyState, repoStatus } from "./repo-status.ts";
export type { ClassifyInput } from "./repo-status.ts";

export interface CollectOptions {
  includeRoot?: boolean;
  /**
   * Every repository the workspace declares, unscoped. Stray detection judges
   * what is on disk against this list, so a `--workspace` scoped run does not
   * mistake another workspace's checkouts for strays. Defaults to the
   * manifest's own repositories.
   */
  knownRepositories?: RepositoryEntry[];
}

export async function collectStatus(
  g: GitRunner,
  manifest: { repositories: RepositoryEntry[] },
  paths: ManifestPaths,
  { includeRoot = true, knownRepositories }: CollectOptions = {},
): Promise<RepoStatus[]> {
  const rows: RepoStatus[] = [];

  // The workspace's own checkout (the directory hosting the manifest) is a
  // repo like any other when it is a git checkout; surface it just like the
  // managed repositories. Its dirty probe ignores untracked files (repos/
  // and worktrees/ are expected workspace contents). Omitted when the
  // command is scoped to a sub-workspace.
  if (includeRoot) {
    const rootInspection = await inspectRepo(g, paths.root, {
      ignoreUntracked: true,
    });
    if (rootInspection.isGit) {
      rows.push(
        await repoStatus(
          g,
          { name: ROOT_LABEL, url: "" },
          paths.root,
          { ignoreUntracked: true },
          rootInspection,
        ),
      );
    }
  }

  rows.push(
    ...await scanStrays(
      knownRepositories ?? manifest.repositories,
      paths,
      (name, path) => repoStatus(g, { name, url: "" }, path),
      includeRoot,
    ),
  );

  for (const repository of manifest.repositories) {
    const repoPath = resolveRepositoryPath(repository, paths);
    if (repository.error) {
      rows.push({
        name: repository.name,
        path: repoPath,
        state: "INVALID",
        detail: repository.error,
      });
      continue;
    }
    rows.push(await repoStatus(g, repository, repoPath));
  }
  return rows;
}

/**
 * Whether a check run should exit non-zero. Stray rows (`UNMANAGED`) are
 * warnings by default; `strict` promotes every unmanaged row, including a
 * clean unmanaged checkout, to a failure.
 */
export function hasErrors(
  statuses: RepoStatus[],
  { strict = false }: { strict?: boolean } = {},
): boolean {
  return statuses.some((s) => {
    if (strict && s.unmanaged) return true;
    return s.state !== "CLEAN" && s.state !== "FEATURE_CLEAN" &&
      s.state !== "UNMANAGED";
  });
}
