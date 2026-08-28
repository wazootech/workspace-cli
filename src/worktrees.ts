import { normalize } from "@std/path";
import { defaultBranch, hasRef } from "./git.ts";
import type { GitResult, GitRunner } from "./git.ts";
import { validateSafeName } from "./validate.ts";
import type { Worktree } from "./types.ts";

export function parseWorktreesPorcelain(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> | undefined;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") {
      if (current?.path) {
        worktrees.push({
          path: current.path,
          branch: current.branch,
          head: current.head,
          bare: current.bare ?? false,
          detached: current.detached ?? false,
        });
      }
      current = undefined;
      continue;
    }
    current ??= {};
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(
        /^refs\/heads\//,
        "",
      );
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  if (current?.path) {
    worktrees.push({
      path: current.path,
      branch: current.branch,
      head: current.head,
      bare: current.bare ?? false,
      detached: current.detached ?? false,
    });
  }
  return worktrees;
}

export async function listWorktrees(
  g: GitRunner,
  repoPath: string,
): Promise<Worktree[]> {
  const result = await g.run(["worktree", "list", "--porcelain"], repoPath);
  return result.code === 0 ? parseWorktreesPorcelain(result.stdout) : [];
}

export async function branchExists(
  g: GitRunner,
  repoPath: string,
  branch: string,
): Promise<boolean> {
  return await hasRef(g, repoPath, `refs/heads/${branch}`);
}

export async function addWorktree(
  g: GitRunner,
  repoPath: string,
  worktreePath: string,
  branch: string,
  startPoint?: string,
): Promise<GitResult> {
  validateSafeName(branch, "Feature branch name");
  if (await branchExists(g, repoPath, branch)) {
    return await g.run(["worktree", "add", worktreePath, branch], repoPath);
  }
  const args = ["worktree", "add", "--no-track", "-b", branch, worktreePath];
  if (startPoint) {
    args.push(startPoint);
  }
  return await g.run(args, repoPath);
}

export async function removeWorktree(
  g: GitRunner,
  repoPath: string,
  worktreePath: string,
): Promise<GitResult> {
  const result = await g.run(["worktree", "remove", worktreePath], repoPath);
  if (result.code === 0) {
    await g.run(["worktree", "prune"], repoPath);
  }
  return result;
}

export async function defaultBranchStartPoint(
  g: GitRunner,
  repoPath: string,
): Promise<string | undefined> {
  const branch = await defaultBranch(g, repoPath);
  return branch ? `origin/${branch}` : undefined;
}

export async function branchIsAncestor(
  g: GitRunner,
  repoPath: string,
  branch: string,
  ref: string,
): Promise<boolean> {
  return (await g.run(["merge-base", "--is-ancestor", branch, ref], repoPath))
    .code === 0;
}

export interface WorktreeStaleness {
  stale: boolean;
  reason?: "merged" | "branch-missing";
}

export async function staleness(
  g: GitRunner,
  repoPath: string,
  wt: Worktree,
  defaultBranchName: string | undefined,
): Promise<WorktreeStaleness> {
  if (normalize(wt.path) === normalize(repoPath)) {
    return { stale: false };
  }
  if (!defaultBranchName || wt.bare || wt.detached || !wt.branch) {
    return { stale: false };
  }
  if (!(await branchExists(g, repoPath, wt.branch))) {
    return { stale: true, reason: "branch-missing" };
  }
  const merged = await branchIsAncestor(
    g,
    repoPath,
    wt.branch,
    `origin/${defaultBranchName}`,
  );
  return merged ? { stale: true, reason: "merged" } : { stale: false };
}
