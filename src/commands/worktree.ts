import { exists } from "@std/fs";
import { join } from "@std/path";
import { defaultBranch } from "@/git.ts";
import type { GitRunner } from "@/git.ts";
import { type ManifestPaths, resolveRepositoryPath } from "@/manifest.ts";
import type { CliOptions } from "@/shared.ts";
import { printRows, scopeManifest } from "@/shared.ts";
import type { WorkspaceManifest } from "@/types.ts";
import {
  addWorktree,
  branchExists,
  defaultBranchStartPoint,
  listWorktrees,
  removeWorktree,
  staleness,
} from "@/worktrees.ts";

export async function run(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  g: GitRunner,
): Promise<number> {
  const scoped = scopeManifest(opts, manifest);
  switch (opts.subcommand) {
    case "list": {
      const rows: {
        repo: string;
        path: string;
        branch?: string;
        bare: boolean;
        detached: boolean;
        stale?: boolean;
        reason?: string;
      }[] = [];
      for (const repository of scoped.repositories) {
        const repoPath = resolveRepositoryPath(repository, paths);
        if (!(await exists(repoPath))) {
          continue;
        }
        const defaultName = opts.stale
          ? await defaultBranch(g, repoPath)
          : undefined;
        for (const wt of await listWorktrees(g, repoPath)) {
          const row: (typeof rows)[number] = {
            repo: repository.name,
            path: wt.path,
            branch: wt.branch,
            bare: wt.bare,
            detached: wt.detached,
          };
          if (opts.stale) {
            const s = await staleness(g, repoPath, wt, defaultName);
            row.stale = s.stale;
            if (s.reason) {
              row.reason = s.reason;
            }
          }
          rows.push(row);
        }
      }
      const filtered = opts.stale ? rows.filter((r) => r.stale) : rows;
      printRows(filtered, opts.json);
      return 0;
    }
    case "add": {
      const [repoName, feature, startPoint] = opts.positional;
      if (!repoName || !feature) {
        console.error(
          "Usage: wspace worktree add <repo> <feature> [<commit-ish>]",
        );
        return 2;
      }
      const repository = scoped.repositories.find((r) => r.name === repoName);
      if (!repository) {
        console.error(`Unknown repository: ${repoName}`);
        return 2;
      }
      const repoPath = resolveRepositoryPath(repository, paths);
      if (!(await exists(repoPath))) {
        console.error(`Repository not cloned: ${repoName}`);
        return 2;
      }
      const worktreePath = join(paths.worktreesDirectory, repoName, feature);
      if (await exists(worktreePath)) {
        console.error(`Worktree path already exists: ${worktreePath}`);
        return 2;
      }
      const reattach = await branchExists(g, repoPath, feature);
      let startPointArg: string | undefined = startPoint;
      if (reattach) {
        console.warn(
          `Branch ${feature} already exists; attaching existing branch`,
        );
      } else {
        startPointArg ??= await defaultBranchStartPoint(g, repoPath);
        if (!startPointArg) {
          console.error(
            "Cannot resolve a default-branch baseline (no origin/HEAD); pass an explicit <commit-ish>",
          );
          return 2;
        }
      }
      if (opts.dryRun) {
        console.log(
          `Would create worktree ${worktreePath} on branch ${feature}`,
        );
        return 0;
      }
      const result = await addWorktree(
        g,
        repoPath,
        worktreePath,
        feature,
        startPointArg,
      );
      if (result.code !== 0) {
        console.error(result.stderr);
        return 1;
      }
      console.log(`Created worktree ${worktreePath} on branch ${feature}`);
      return 0;
    }
    case "remove": {
      const [repoName, feature] = opts.positional;
      if (!repoName || !feature) {
        console.error("Usage: wspace worktree remove <repo> <feature>");
        return 2;
      }
      const repository = scoped.repositories.find((r) => r.name === repoName);
      if (!repository) {
        console.error(`Unknown repository: ${repoName}`);
        return 2;
      }
      const repoPath = resolveRepositoryPath(repository, paths);
      if (!(await exists(repoPath))) {
        console.error(`Repository not cloned: ${repoName}`);
        return 2;
      }
      const worktreePath = join(paths.worktreesDirectory, repoName, feature);
      if (opts.dryRun) {
        console.log(`Would remove worktree ${worktreePath}`);
        return 0;
      }
      const result = await removeWorktree(g, repoPath, worktreePath);
      if (result.code !== 0) {
        console.error(result.stderr);
        return 1;
      }
      await Deno.remove(join(paths.worktreesDirectory, repoName), {
        recursive: false,
      }).catch(() => {});
      console.log(`Removed worktree ${worktreePath}`);
      return 0;
    }
    default:
      console.error("Usage: wspace worktree add|list|remove");
      return 2;
  }
}
