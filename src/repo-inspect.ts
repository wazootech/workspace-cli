import { join } from "@std/path";
import type { GitRunner } from "./git.ts";
import {
  currentBranch,
  defaultBranch,
  hasDefaultBranchWorktree,
  isDirty,
} from "./git.ts";
import { exists } from "@std/fs";

/**
 * Structured result of inspecting a single repository on disk.
 * Callers consume this and add their own logic (classification,
 * action planning, staleness checking).
 */
export interface RepoInspection {
  exists: boolean;
  isGit: boolean;
  branch?: string;
  defaultBranch?: string;
  dirty: boolean;
  defaultBranchCheckedOutInWorktree: boolean;
}

/**
 * Inspection options. `ignoreUntracked` is used for the workspace root,
 * where untracked `repos/` and `worktrees/` directories are the expected
 * workspace contents rather than a signal of user work.
 */
export interface InspectOptions {
  ignoreUntracked?: boolean;
}

/**
 * Inspect a repository at the given path. Returns a structured result
 * with the common git state that multiple callers need. Does not
 * classify state or plan actions — callers add that logic.
 */
export async function inspectRepo(
  g: GitRunner,
  repoPath: string,
  opts: InspectOptions = {},
): Promise<RepoInspection> {
  if (!(await exists(repoPath))) {
    return {
      exists: false,
      isGit: false,
      dirty: false,
      defaultBranchCheckedOutInWorktree: false,
    };
  }
  if (!(await exists(join(repoPath, ".git")))) {
    return {
      exists: true,
      isGit: false,
      dirty: false,
      defaultBranchCheckedOutInWorktree: false,
    };
  }

  const branch = await currentBranch(g, repoPath);
  const defaultBranchName = await defaultBranch(g, repoPath);
  const dirty = await isDirty(g, repoPath, opts.ignoreUntracked);
  const defaultBranchCheckedOutInWorktree = defaultBranchName !== undefined &&
    branch !== defaultBranchName &&
    await hasDefaultBranchWorktree(g, repoPath, defaultBranchName);

  return {
    exists: true,
    isGit: true,
    branch,
    defaultBranch: defaultBranchName,
    dirty,
    defaultBranchCheckedOutInWorktree,
  };
}
