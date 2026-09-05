import type { GitRunner } from "./git.ts";
import { branchAb, fastForwardMerge, fetch } from "./git.ts";
import { type ManifestPaths, resolveRepositoryPath } from "./manifest-paths.ts";
import {
  type RepositoryEntry,
  ROOT_LABEL,
  type UpdateAction,
} from "./types.ts";
import {
  type InspectOptions,
  inspectRepo,
  type RepoInspection,
} from "./repo-inspect.ts";

async function planRepoUpdate(
  g: GitRunner,
  name: string,
  repoPath: string,
  dryRun: boolean,
  inspectOpts: InspectOptions = {},
  inspection?: RepoInspection,
): Promise<UpdateAction> {
  // Callers that already inspected (e.g. the workspace root, whose git-ness
  // gates inclusion) pass the inspection through so it is computed once.
  inspection ??= await inspectRepo(g, repoPath, inspectOpts);

  if (!inspection.exists) {
    return { kind: "MISSING", name };
  }
  if (!inspection.isGit) {
    return {
      kind: "INVALID",
      name,
      detail: "Path exists but is not a Git repository",
    };
  }

  const branch = inspection.branch;
  const defaultBranchName = inspection.defaultBranch;
  const dirty = inspection.dirty;

  if (dirty) {
    return {
      kind: "SKIP_DIRTY",
      name,
      detail: "uncommitted changes",
    };
  }
  if (branch && branch !== defaultBranchName) {
    return {
      kind: "SKIP_FEATURE",
      name,
      detail: `${branch} != ${defaultBranchName}`,
    };
  }
  if (!defaultBranchName) {
    return {
      kind: "SKIP_NO_DEFAULT",
      name,
      detail: "no origin/HEAD",
    };
  }

  if (inspection.defaultBranchCheckedOutInWorktree) {
    return {
      kind: "SKIP_FEATURE",
      name,
      detail: `${defaultBranchName} checked out in a worktree`,
    };
  }

  // Dry-run: skip network calls (fetch) and mutations (merge).
  if (dryRun) {
    return {
      kind: "WOULD_FAST_FORWARD",
      name,
      detail: `origin/${defaultBranchName}`,
    };
  }

  if (!(await fetch(g, repoPath))) {
    return { kind: "FETCH_FAILED", name };
  }

  const upstream = `origin/${defaultBranchName}`;
  const ab = await branchAb(g, repoPath, upstream);
  if (!ab) {
    return {
      kind: "SKIP_NO_DEFAULT",
      name,
      detail: "upstream tracking ref missing",
    };
  }
  if (ab.ahead > 0) {
    return {
      kind: "SKIP_AHEAD",
      name,
      detail: `${ab.ahead} ahead, ${ab.behind} behind`,
    };
  }
  if (ab.behind === 0) {
    return {
      kind: "CURRENT",
      name,
      detail: upstream,
    };
  }

  const ok = await fastForwardMerge(g, repoPath, upstream);
  return ok ? { kind: "FAST_FORWARD", name, commits: ab.behind } : {
    kind: "FAST_FORWARD_FAILED",
    name,
    detail: upstream,
  };
}

/**
 * Plan an update for one checkout. Returns the single action for a git repo,
 * or undefined when the path is not a git repo (used for the workspace root,
 * which may legitimately be a plain directory).
 */
async function planGitUpdate(
  g: GitRunner,
  name: string,
  repoPath: string,
  dryRun: boolean,
  inspectOpts: InspectOptions = {},
): Promise<UpdateAction | undefined> {
  const inspection = await inspectRepo(g, repoPath, inspectOpts);
  if (!inspection.isGit) {
    return undefined;
  }
  return await planRepoUpdate(
    g,
    name,
    repoPath,
    dryRun,
    inspectOpts,
    inspection,
  );
}

export async function planUpdate(
  g: GitRunner,
  repositories: RepositoryEntry[],
  paths: ManifestPaths,
  { dryRun = false, includeRoot = true }: {
    dryRun?: boolean;
    includeRoot?: boolean;
  } = {},
): Promise<UpdateAction[]> {
  const actions: UpdateAction[] = [];

  // The workspace's own checkout (the directory hosting the manifest) is
  // subject to the same conservative update policy when it is a git repo.
  // Untracked files are ignored in its dirty probe: repos/ and worktrees/
  // are the expected workspace contents, not user work. Omitted when the
  // command is scoped to a sub-workspace.
  if (includeRoot) {
    const rootAction = await planGitUpdate(
      g,
      ROOT_LABEL,
      paths.root,
      dryRun,
      { ignoreUntracked: true },
    );
    if (rootAction) {
      actions.push(rootAction);
    }
  }

  for (const repository of repositories) {
    const repoPath = resolveRepositoryPath(repository, paths);
    actions.push(await planRepoUpdate(g, repository.name, repoPath, dryRun));
  }
  return actions;
}

export async function runUpdate(
  g: GitRunner,
  manifest: { repositories: RepositoryEntry[] },
  paths: ManifestPaths,
  { dryRun = false, includeRoot = true }: {
    dryRun?: boolean;
    includeRoot?: boolean;
  } = {},
): Promise<UpdateAction[]> {
  return await planUpdate(g, manifest.repositories, paths, {
    dryRun,
    includeRoot,
  });
}
