import { exists } from "@std/fs";
import { join } from "@std/path";
import { clone } from "../git.ts";
import type { GitRunner } from "../git.ts";
import {
  manifestPaths,
  resolveRepositoryPath,
  resolveWorkspaceTree,
} from "../manifest.ts";
import type { ManifestPaths } from "../manifest.ts";
import type { CliOptions } from "../shared.ts";
import { flattenResolved, printRows } from "../shared.ts";
import type { WorkspaceManifest } from "../types.ts";

type InstallRow = { name: string; state: string; detail?: string };

function isBadInstallRow(row: InstallRow): boolean {
  return (
    row.state === "CLONE_FAILED" ||
    row.state === "PATH_BLOCKED" ||
    row.state === "INVALID" ||
    row.state === "UNKNOWN_REPO"
  );
}

async function cloneMissing(
  g: GitRunner,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  targets: string[] = [],
): Promise<InstallRow[]> {
  await Deno.mkdir(paths.repositoriesDirectory, { recursive: true });
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
 * Resolve the workspace tree, clone missing repositories, and print results.
 */
export async function run(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  manifestPath: string,
  g: GitRunner,
): Promise<number> {
  const targets = opts.subcommand ? [opts.subcommand, ...opts.positional] : [];
  const paths = manifestPaths(manifest, manifestPath);

  const resolved = resolveWorkspaceTree(manifest, manifestPath);
  const flat = flattenResolved(resolved, manifest);

  const scoped = opts.workspace
    ? {
      ...flat,
      repositories: flat.repositories.filter(
        (r) => r.workspace === opts.workspace,
      ),
    }
    : flat;

  const rows = await cloneMissing(g, scoped, paths, targets);
  printRows(rows, opts.json);

  const failed = rows.some(isBadInstallRow);
  if (!failed) {
    console.error(
      `NOTE: Fresh clones do not contain files listed in .gitignore.
Required setup steps may include:
  - Running npm install / deno install / pip install etc. in each repo
  - Copying .env files from secrets/ (run: works env sync)
  - Any repo-specific setup documented in each repo's README`,
    );
  }
  return failed ? 1 : 0;
}
