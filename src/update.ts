import { join, normalize } from "@std/path";
import type { GitRunner } from "./git.ts";
import {
  branchAb,
  currentBranch,
  defaultBranch,
  fastForwardMerge,
  fetch,
  isDirty,
} from "./git.ts";
import { exists } from "@std/fs";
import { resolveRepositoryPath } from "./manifest.ts";
import type { ManifestPaths } from "./manifest.ts";
import type { RepositoryEntry, UpdateAction } from "./types.ts";
import { listWorktrees } from "./worktrees.ts";

export async function planUpdate(
  g: GitRunner,
  repositories: RepositoryEntry[],
  paths: ManifestPaths,
): Promise<UpdateAction[]> {
  const actions: UpdateAction[] = [];
  for (const repository of repositories) {
    const repoPath = resolveRepositoryPath(repository, paths);
    if (!(await exists(repoPath))) {
      actions.push({ kind: "MISSING", name: repository.name });
      continue;
    }
    if (!(await exists(join(repoPath, ".git")))) {
      actions.push({ kind: "INVALID", name: repository.name });
      continue;
    }

    const branch = await currentBranch(g, repoPath);
    const defaultBranchName = await defaultBranch(g, repoPath);
    const dirty = await isDirty(g, repoPath);

    if (dirty) {
      actions.push({
        kind: "SKIP_DIRTY",
        name: repository.name,
        detail: "uncommitted changes",
      });
      continue;
    }
    if (branch && branch !== defaultBranchName) {
      actions.push({
        kind: "SKIP_FEATURE",
        name: repository.name,
        detail: `${branch} != ${defaultBranchName}`,
      });
      continue;
    }
    if (!defaultBranchName) {
      actions.push({
        kind: "SKIP_NO_DEFAULT",
        name: repository.name,
        detail: "no origin/HEAD",
      });
      continue;
    }

    const worktrees = await listWorktrees(g, repoPath);
    const linkedWorktrees = worktrees.filter(
      (w) => normalize(w.path) !== normalize(repoPath),
    );
    if (linkedWorktrees.some((w) => w.branch === defaultBranchName)) {
      actions.push({
        kind: "SKIP_FEATURE",
        name: repository.name,
        detail: `${defaultBranchName} checked out in a worktree`,
      });
      continue;
    }

    if (!(await fetch(g, repoPath))) {
      actions.push({ kind: "FETCH_FAILED", name: repository.name });
      continue;
    }

    const upstream = `origin/${defaultBranchName}`;
    const ab = await branchAb(g, repoPath, upstream);
    if (!ab) {
      actions.push({
        kind: "SKIP_NO_DEFAULT",
        name: repository.name,
        detail: "upstream tracking ref missing",
      });
      continue;
    }
    if (ab.ahead > 0) {
      actions.push({
        kind: "SKIP_AHEAD",
        name: repository.name,
        detail: `${ab.ahead} ahead, ${ab.behind} behind`,
      });
      continue;
    }
    if (ab.behind === 0) {
      actions.push({
        kind: "CURRENT",
        name: repository.name,
        detail: upstream,
      });
      continue;
    }

    const ok = await fastForwardMerge(g, repoPath, upstream);
    actions.push(
      ok
        ? { kind: "FAST_FORWARD", name: repository.name, commits: ab.behind }
        : {
          kind: "FAST_FORWARD_FAILED",
          name: repository.name,
          detail: upstream,
        },
    );
  }
  return actions;
}

export async function runUpdate(
  g: GitRunner,
  manifest: { repositories: RepositoryEntry[] },
  paths: ManifestPaths,
): Promise<UpdateAction[]> {
  return await planUpdate(g, manifest.repositories, paths);
}
