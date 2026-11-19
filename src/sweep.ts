import type { GitRunner } from "./git.ts";
import {
  deleteBranch,
  deleteRemoteBranch,
  fetch,
  isDirty,
  type WorktreeEntry,
  worktreeList,
} from "./git.ts";
import { resolveRepositoryPath } from "./manifest-paths.ts";
import { purgeDirectory } from "./purge.ts";
import { ROOT_LABEL, type SweepAction } from "./types.ts";
import type { RepositoryEntry } from "./types.ts";
import { inspectRepo } from "./repo-inspect.ts";
import {
  proveMerged,
  type RemoteProofOptions,
  resolveBaseline,
} from "./sweep-proof.ts";

export interface SweepOptions {
  dryRun?: boolean;
  /** Also delete `origin/<branch>`. Off by default: a sweep must never
   * silently delete remote refs. */
  deleteRemote?: boolean;
  /** Override both safety gates. */
  force?: boolean;
  /** Omit the workspace root when scoping to a sub-workspace. */
  includeRoot?: boolean;
  /**
   * A `gh` runner for the remote proof tier, which recognises branches whose
   * PR was squash- or rebase-merged. Omit it to prove merges offline only.
   */
  gh?: GitRunner;
}

/** The options every per-worktree step reads, defaults applied. */
type ResolvedOptions =
  & Required<Pick<SweepOptions, "dryRun" | "force" | "deleteRemote">>
  & Pick<SweepOptions, "gh">;

/** Remove the worktree, falling back to a directory purge when git refuses. */
async function removeWorktree(
  g: GitRunner,
  repoPath: string,
  entry: WorktreeEntry,
): Promise<string | undefined> {
  const result = await g.run(["worktree", "remove", entry.path], repoPath);
  if (result.code === 0) return undefined;
  const strategy = await purgeDirectory(entry.path);
  if (strategy === undefined) {
    return result.stderr || "worktree remove failed";
  }
  // The registration still exists; prune drops it now the tree is gone.
  await g.run(["worktree", "prune"], repoPath);
  return undefined;
}

async function sweepWorktree(
  g: GitRunner,
  name: string,
  repoPath: string,
  entry: WorktreeEntry,
  baseline: string,
  defaultBranchName: string,
  opts: ResolvedOptions,
): Promise<SweepAction> {
  const branch = entry.branch;

  if (!branch) {
    return {
      kind: "SKIP_DETACHED",
      name,
      worktree: entry.path,
      detail: "no branch to prove",
    };
  }
  // Narrowed to a definite branch, so every row below carries a branch name.
  const base = { name, branch, worktree: entry.path };

  if (!opts.force && await isDirty(g, entry.path)) {
    return {
      kind: "SKIP_DIRTY",
      ...base,
      detail: "uncommitted or untracked changes",
    };
  }

  const remote: RemoteProofOptions | undefined = opts.gh && {
    gh: opts.gh,
    baseBranch: defaultBranchName,
    fetchMissing: !opts.dryRun,
  };
  const proof = await proveMerged(g, repoPath, baseline, branch, remote);
  if (!proof && !opts.force) {
    return {
      kind: "SKIP_NOT_MERGED",
      ...base,
      detail: `no merge proof against ${baseline}`,
    };
  }
  const detail = proof?.detail ?? "forced (no merge proof)";

  if (opts.dryRun) {
    return { kind: "WOULD_REMOVE", ...base, detail };
  }

  const removalError = await removeWorktree(g, repoPath, entry);
  if (removalError !== undefined) {
    return { kind: "FAILED", ...base, detail: removalError };
  }

  if (!(await deleteBranch(g, repoPath, branch))) {
    return {
      kind: "FAILED",
      ...base,
      detail: "worktree removed but branch delete failed",
    };
  }

  if (!opts.deleteRemote) {
    return { kind: "SKIPPED_REMOTE", ...base, detail };
  }
  if (await deleteRemoteBranch(g, repoPath, "origin", branch)) {
    return { kind: "REMOVED", ...base, detail };
  }
  return {
    kind: "FAILED",
    ...base,
    detail: "local cleanup done but origin/<branch> delete failed",
  };
}

/**
 * Plan or run a sweep for one repository. Returns no rows when the path is not
 * a git checkout (the workspace root may legitimately be a plain directory) or
 * when it has no candidate worktrees.
 */
async function sweepRepo(
  g: GitRunner,
  name: string,
  repoPath: string,
  opts: ResolvedOptions,
): Promise<SweepAction[]> {
  // Guard on a real checkout before running git. Without this, `git -C <dir>
  // worktree list` on a non-repo directory (e.g. repos/worktrees/) silently
  // walks up and reports an ancestor repository's worktrees.
  const inspection = await inspectRepo(g, repoPath, { ignoreUntracked: true });
  if (!inspection.isGit) return [];

  const defaultBranchName = inspection.defaultBranch;
  if (!defaultBranchName) {
    return [{ kind: "SKIP_NO_DEFAULT", name, detail: "no origin/HEAD" }];
  }

  const worktrees = await worktreeList(g, repoPath);
  // The first entry is the main worktree (the canonical checkout itself),
  // which is never a candidate.
  const candidates = worktrees.slice(1);
  if (candidates.length === 0) return [];

  // A dry run must not touch the network; a real run needs fresh refs to
  // prove against.
  if (!opts.dryRun && !(await fetch(g, repoPath))) {
    return [{ kind: "FAILED", name, detail: "fetch failed" }];
  }

  const baseline = await resolveBaseline(g, repoPath, defaultBranchName);
  const rows: SweepAction[] = [];
  for (const entry of candidates) {
    if (entry.branch === defaultBranchName) {
      // A default branch checked out in a linked worktree is never a target:
      // deleting it would rewrite the checkout update fast-forwards.
      rows.push({
        kind: "SKIP_DEFAULT",
        name,
        branch: entry.branch,
        worktree: entry.path,
        detail: "default branch is never a sweep target",
      });
      continue;
    }
    rows.push(
      await sweepWorktree(
        g,
        name,
        repoPath,
        entry,
        baseline,
        defaultBranchName,
        opts,
      ),
    );
  }
  return rows;
}

export async function runSweep(
  g: GitRunner,
  manifest: { repositories: RepositoryEntry[] },
  paths: {
    root: string;
    repositoriesDirectory: string;
    workspacesDirectory?: string;
  },
  {
    dryRun = false,
    deleteRemote = false,
    force = false,
    includeRoot = true,
    gh,
  }: SweepOptions = {},
): Promise<SweepAction[]> {
  const opts: ResolvedOptions = { dryRun, force, deleteRemote, gh };
  const rows: SweepAction[] = [];

  // The workspace root carries the manifest's own worktrees, which are not
  // reachable through any manifest entry, so it is swept like any other repo.
  if (includeRoot) {
    rows.push(...await sweepRepo(g, ROOT_LABEL, paths.root, opts));
  }

  for (const repository of manifest.repositories) {
    const repoPath = resolveRepositoryPath(repository, paths);
    rows.push(...await sweepRepo(g, repository.name, repoPath, opts));
  }
  return rows;
}
