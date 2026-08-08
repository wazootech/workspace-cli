import type { GitResult, GitRunner } from "./git.ts";
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

export async function addWorktree(
  g: GitRunner,
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<GitResult> {
  return await g.run(
    ["worktree", "add", "--track", "-b", branch, worktreePath],
    repoPath,
  );
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
