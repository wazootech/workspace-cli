import { join } from "@std/path";
import type { GitRunner } from "./git.ts";
import { exists, resolveRepositoryPath } from "./manifest.ts";
import type { ManifestPaths } from "./manifest.ts";
import type { WorkspaceManifest } from "./types.ts";
import { listWorktrees } from "./worktrees.ts";

const DEFAULT_LOCAL_FILE_PATTERNS = [
  ".env",
  ".env.*",
  ".dev.vars",
  ".dev.vars.*",
];

export function isLocalConfigFile(
  name: string,
  extraPatterns: string[] = [],
): boolean {
  if (name.endsWith(".example") || name.endsWith(".template")) {
    return false;
  }
  const patterns = [...DEFAULT_LOCAL_FILE_PATTERNS, ...extraPatterns];
  return patterns.some((pattern) => matchPattern(pattern, name));
}

function matchPattern(pattern: string, name: string): boolean {
  if (pattern === name) {
    return true;
  }
  if (pattern.endsWith(".*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  if (pattern.startsWith("*.")) {
    return name.endsWith(pattern.slice(1));
  }
  return false;
}

export interface SyncEnvResult {
  repo: string;
  file: string;
  destination: string;
}

export async function syncEnv(
  g: GitRunner,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
): Promise<SyncEnvResult[]> {
  const synced: SyncEnvResult[] = [];
  if (!(await exists(paths.vaultDirectory))) {
    return synced;
  }

  for (const repository of manifest.repositories) {
    const vaultRepoDir = join(paths.vaultDirectory, repository.name);
    if (!(await exists(vaultRepoDir))) {
      continue;
    }

    const repoPath = resolveRepositoryPath(repository, paths);
    const targets = [repoPath];
    if (await exists(repoPath)) {
      for (const worktree of await listWorktrees(g, repoPath)) {
        targets.push(worktree.path);
      }
    }

    const patterns = repository.localFiles ?? [];
    for await (const fileEntry of Deno.readDir(vaultRepoDir)) {
      if (!fileEntry.isFile) {
        continue;
      }
      if (!isLocalConfigFile(fileEntry.name, patterns)) {
        continue;
      }
      const source = join(vaultRepoDir, fileEntry.name);
      for (const target of targets) {
        if (!(await exists(target))) {
          continue;
        }
        const destination = join(target, fileEntry.name);
        await Deno.copyFile(source, destination);
        synced.push({
          repo: repository.name,
          file: fileEntry.name,
          destination,
        });
      }
    }
  }
  return synced;
}
