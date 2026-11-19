import { join } from "@std/path";
import { clone } from "@/git.ts";
import type { GitRunner } from "@/git.ts";
import { type ManifestPaths, resolveRepositoryPath } from "@/manifest-paths.ts";
import type { CliOptions } from "@/cli-options.ts";
import { printRows } from "@/output.ts";
import { makeDirectory, pathExists } from "@/runtime.ts";
import type { WorkspaceManifest } from "@/types.ts";
import {
  type InstallRow,
  isBadInstallRow,
  workspaceManifestMissing,
} from "@/commands/install-rows.ts";
import { clearBlockingPath } from "@/commands/install-force.ts";

async function cloneMissing(
  g: GitRunner,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  targets: string[] = [],
  { dryRun = false, force = false }: { dryRun?: boolean; force?: boolean } = {},
): Promise<InstallRow[]> {
  if (!dryRun) {
    await makeDirectory(paths.repositoriesDirectory);
    if (paths.workspacesDirectory !== undefined) {
      await makeDirectory(paths.workspacesDirectory);
    }
  }
  let repositories = manifest.repositories;
  if (targets.length > 0) {
    const validNames = new Set(manifest.repositories.map((r) => r.name));
    for (const name of targets) {
      if (!validNames.has(name)) {
        return [{
          name,
          state: "UNKNOWN_REPO",
          detail: `Repository "${name}" not found in manifest`,
        }];
      }
    }
    const targetSet = new Set(targets);
    repositories = repositories.filter((r) => targetSet.has(r.name));
  }
  const rows: InstallRow[] = [];
  for (const repository of repositories) {
    const repoPath = resolveRepositoryPath(repository, paths);
    let cleared = false;
    if (force) {
      const clearance = await clearBlockingPath(
        repository.name,
        repoPath,
        dryRun,
      );
      if (clearance.kind === "row") {
        rows.push(clearance.row);
        continue;
      }
      cleared = clearance.kind === "cleared";
    }
    if (await pathExists(repoPath)) {
      const invalidWorkspace = await workspaceManifestMissing(
        repository,
        repoPath,
      );
      if (invalidWorkspace) {
        rows.push(invalidWorkspace);
      } else if (await pathExists(join(repoPath, ".git"))) {
        rows.push({ name: repository.name, state: "EXISTS" });
      } else {
        rows.push({
          name: repository.name,
          state: "PATH_BLOCKED",
          detail: "Path exists but is not a Git repository",
        });
      }
      continue;
    }
    if (!repository.url) {
      throw new Error(
        `Repository "${repository.name}" is missing its clone url`,
      );
    }
    if (dryRun) {
      rows.push({ name: repository.name, state: "WOULD_CLONE" });
      continue;
    }
    const result = await clone(g, repository.url, repoPath);
    if (result.code === 0) {
      const invalidWorkspace = await workspaceManifestMissing(
        repository,
        repoPath,
      );
      rows.push(
        invalidWorkspace ?? {
          name: repository.name,
          state: "CLONED",
          ...(cleared && { detail: "cleared empty placeholder directory" }),
        },
      );
    } else {
      rows.push({
        name: repository.name,
        state: "CLONE_FAILED",
        detail: result.stderr.trim() || `Exit code ${result.code}`,
      });
    }
  }
  return rows;
}

/**
 * Clone missing repositories from the pre-resolved manifest.
 * Receives the resolved manifest and paths from cli.ts — no re-resolution.
 */
export async function run(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  g: GitRunner,
): Promise<number> {
  const targets = opts.subcommand ? [opts.subcommand, ...opts.positional] : [];

  const scoped = opts.workspace
    ? {
      ...manifest,
      repositories: manifest.repositories.filter(
        (r) => r.workspace === opts.workspace,
      ),
    }
    : manifest;

  const rows = await cloneMissing(g, scoped, paths, targets, {
    dryRun: opts.dryRun,
    force: opts.force,
  });
  printRows(rows, opts.json);

  const failed = rows.some(isBadInstallRow);
  if (!failed && !opts.dryRun) {
    console.error(
      `NOTE: Fresh clones do not contain files listed in .gitignore.\nRequired setup steps may include:\n  - Running npm install / deno install / pip install etc. in each repo\n  - Copying local credentials or .env files into the checkout manually\n  - Any repo-specific setup documented in each repo's README`,
    );
  }
  return failed ? 1 : 0;
}
