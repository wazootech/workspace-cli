import { join, normalize, relative, resolve } from "@std/path";
import type { GitRunner } from "./git.ts";
import {
  branchAb,
  configuredUpstream,
  currentBranch,
  defaultBranch,
  hasRef,
  isDirty,
} from "./git.ts";
import { exists } from "@std/fs";
import { type ManifestPaths, resolveRepositoryPath } from "./manifest.ts";
import type { RepositoryEntry, RepoState, RepoStatus } from "./types.ts";
import { listWorktrees } from "./worktrees.ts";

export interface ClassifyInput {
  dirty: boolean;
  featureBranch: boolean;
  hasDefaultBranch: boolean;
  upstream?: string;
  upstreamRefExists?: boolean;
  aheadBehind?: { ahead: number; behind: number };
}

export function classifyState(input: ClassifyInput): {
  state: RepoState;
  detail?: string;
} {
  if (input.dirty) {
    return { state: "DIRTY" };
  }
  if (input.featureBranch) {
    return { state: "FEATURE_CLEAN" };
  }
  if (!input.hasDefaultBranch) {
    return { state: "UNKNOWN", detail: "no origin/HEAD" };
  }
  if (!input.upstream) {
    return { state: "UNKNOWN", detail: "no upstream configured" };
  }
  if (!input.upstreamRefExists) {
    return { state: "UNKNOWN", detail: "missing tracking ref" };
  }
  if (!input.aheadBehind) {
    return { state: "UNKNOWN", detail: "ahead/behind unavailable" };
  }
  if (input.aheadBehind.ahead > 0 || input.aheadBehind.behind > 0) {
    return {
      state: "DIVERGED",
      detail:
        `${input.aheadBehind.ahead} ahead, ${input.aheadBehind.behind} behind`,
    };
  }
  return { state: "CLEAN" };
}

export async function repoStatus(
  g: GitRunner,
  repository: RepositoryEntry,
  repoPath: string,
): Promise<RepoStatus> {
  const base = { name: repository.name, path: repoPath };
  if (!(await exists(repoPath))) {
    return { ...base, state: "MISSING" };
  }
  if (!(await exists(join(repoPath, ".git")))) {
    return { ...base, state: "INVALID" };
  }

  try {
    const branch = await currentBranch(g, repoPath);
    const defaultBr = await defaultBranch(g, repoPath);
    const dirty = await isDirty(g, repoPath);
    const upstream = branch
      ? await configuredUpstream(g, repoPath, branch)
      : undefined;
    const featureBranch = branch !== undefined && branch !== defaultBr;

    let ahead: number | undefined;
    let behind: number | undefined;
    let upstreamRefExists: boolean | undefined;
    if (upstream && branch) {
      upstreamRefExists = await hasRef(g, repoPath, `refs/remotes/${upstream}`);
      if (upstreamRefExists) {
        const ab = await branchAb(g, repoPath, upstream);
        if (ab) {
          ahead = ab.ahead;
          behind = ab.behind;
        }
      }
    }

    const classified = classifyState({
      dirty,
      featureBranch,
      hasDefaultBranch: defaultBr !== undefined,
      upstream,
      upstreamRefExists,
      aheadBehind: ahead !== undefined
        ? { ahead, behind: behind ?? 0 }
        : undefined,
    });

    return {
      ...base,
      branch,
      defaultBranch: defaultBr,
      upstream,
      ahead,
      behind,
      state: classified.state,
      detail: classified.detail,
    };
  } catch (err) {
    return {
      ...base,
      state: "ERROR",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function collectStatus(
  g: GitRunner,
  manifest: { repositories: RepositoryEntry[] },
  paths: ManifestPaths,
): Promise<RepoStatus[]> {
  const rows: RepoStatus[] = [];
  const managed = new Set(manifest.repositories.map((r) => r.name));
  const managedPaths = new Set(
    manifest.repositories.map((r) =>
      normalize(resolveRepositoryPath(r, paths))
    ),
  );
  const reposDir = paths.repositoriesDirectory;

  if (await exists(reposDir)) {
    for await (const entry of Deno.readDir(reposDir)) {
      if (!entry.isDirectory || entry.name === ".git") {
        continue;
      }
      if (managed.has(entry.name)) {
        continue;
      }
      const candidatePath = normalize(resolve(reposDir, entry.name));
      if (managedPaths.has(candidatePath)) {
        continue;
      }
      if (await exists(join(candidatePath, ".git"))) {
        rows.push(
          await repoStatus(
            g,
            { name: `(unmanaged) ${entry.name}`, url: "" },
            candidatePath,
          ),
        );
      }
    }
  }

  for (const repository of manifest.repositories) {
    const repoPath = resolveRepositoryPath(repository, paths);
    const mainStatus = await repoStatus(g, repository, repoPath);
    rows.push(mainStatus);

    if (mainStatus.state !== "MISSING" && mainStatus.state !== "INVALID") {
      try {
        const wts = await listWorktrees(g, repoPath);
        for (const wt of wts) {
          if (normalize(wt.path) === normalize(repoPath)) {
            continue;
          }
          const wtExist = await exists(wt.path);
          let wtState: RepoState = "FEATURE_CLEAN";
          let wtDetail: string | undefined;

          if (!wtExist) {
            wtState = "MISSING";
            wtDetail = "worktree directory missing";
          } else {
            try {
              const dirty = await isDirty(g, wt.path);
              if (dirty) {
                wtState = "WORKTREE_DIRTY";
                wtDetail = "uncommitted changes";
              } else if (wt.detached) {
                wtState = "FEATURE_CLEAN";
                wtDetail = "detached HEAD";
              }
            } catch (err) {
              wtState = "ERROR";
              wtDetail = err instanceof Error ? err.message : String(err);
            }
          }

          rows.push({
            name: `${repository.name} (worktree: ${
              wt.branch ?? relative(paths.root, wt.path)
            })`,
            path: wt.path,
            branch: wt.branch,
            state: wtState,
            detail: wtDetail,
            isWorktree: true,
            worktreePath: wt.path,
          });
        }
      } catch (err) {
        rows.push({
          name: `${repository.name} (worktrees)`,
          path: repoPath,
          state: "ERROR",
          detail: `Failed to inspect worktrees: ${
            err instanceof Error ? err.message : String(err)
          }`,
          isWorktree: true,
        });
      }
    }
  }
  return rows;
}

export function hasErrors(statuses: RepoStatus[]): boolean {
  return statuses.some(
    (s) => s.state !== "CLEAN" && s.state !== "FEATURE_CLEAN",
  );
}
