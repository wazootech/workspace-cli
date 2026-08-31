import { exists } from "@std/fs";
import { join } from "@std/path";
import { clone } from "@/git.ts";
import type { GitRunner } from "@/git.ts";
import { type ManifestPaths, resolveRepositoryPath } from "@/manifest-paths.ts";
import type { CliOptions } from "@/cli-options.ts";
import { printRows } from "@/output.ts";
import type { WorkspaceManifest } from "@/types.ts";

type InstallRow = { name: string; state: string; detail?: string };

function isBadInstallRow(row: InstallRow): boolean {
  return (
    row.state === "CLONE_FAILED" || row.state === "PATH_BLOCKED" ||
    row.state === "INVALID" || row.state === "UNKNOWN_REPO"
  );
}

async function cloneMissing(
  g: GitRunner,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  targets: string[] = [],
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<InstallRow[]> {
  if (!dryRun) {
    await Deno.mkdir(paths.repositoriesDirectory, { recursive: true });
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
    if (await exists(repoPath)) {
      if (await exists(join(repoPath, ".git"))) {
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
    rows.push(
      result.code === 0 ? { name: repository.name, state: "CLONED" } : {
        name: repository.name,
        state: "CLONE_FAILED",
        detail: result.stderr.trim() || `Exit code ${result.code}`,
      },
    );
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
  });
  printRows(rows, opts.json);

  const failed = rows.some(isBadInstallRow);
  if (!failed && !opts.dryRun) {
    console.error(
      `NOTE: Fresh clones do not contain files listed in .gitignore.\nRequired setup steps may include:\n  - Running npm install / deno install / pip install etc. in each repo\n  - Copying .env files from secrets/ (run: wspace env sync)\n  - Any repo-specific setup documented in each repo's README`,
    );
  }
  return failed ? 1 : 0;
}
