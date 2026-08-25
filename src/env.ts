import { join } from "@std/path";
import { exists } from "@std/fs";
import type { GitRunner } from "./git.ts";
import { resolveRepositoryPath } from "./manifest.ts";
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

export interface SyncEnvOptions {
  dryRun?: boolean;
}

export interface SyncEnvResult {
  repo: string;
  file: string;
  destination: string;
  action:
    | "CREATED"
    | "OVERWRITTEN"
    | "WOULD_CREATE"
    | "WOULD_OVERWRITE"
    | "SKIPPED"
    | "FAILED";
  reason?: string;
}

export async function syncEnv(
  g: GitRunner,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  options: SyncEnvOptions = {},
): Promise<SyncEnvResult[]> {
  const synced: SyncEnvResult[] = [];
  if (!(await exists(paths.secretsDirectory))) {
    return synced;
  }

  for (const repository of manifest.repositories) {
    const vaultRepoDir = join(paths.secretsDirectory, repository.name);
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

    for await (const fileEntry of Deno.readDir(vaultRepoDir)) {
      if (!fileEntry.isFile) {
        continue;
      }
      if (!isLocalConfigFile(fileEntry.name)) {
        continue;
      }
      const source = join(vaultRepoDir, fileEntry.name);
      for (const target of targets) {
        if (!(await exists(target))) {
          continue;
        }
        const destination = join(target, fileEntry.name);

        let destExists = false;
        try {
          const lstat = await Deno.lstat(destination);
          destExists = true;
          if (lstat.isSymlink) {
            synced.push({
              repo: repository.name,
              file: fileEntry.name,
              destination,
              action: "FAILED",
              reason: "Destination is a symlink (rejected for security)",
            });
            continue;
          }
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) {
            synced.push({
              repo: repository.name,
              file: fileEntry.name,
              destination,
              action: "FAILED",
              reason: err instanceof Error ? err.message : String(err),
            });
            continue;
          }
        }

        if (options.dryRun) {
          synced.push({
            repo: repository.name,
            file: fileEntry.name,
            destination,
            action: destExists ? "WOULD_OVERWRITE" : "WOULD_CREATE",
          });
          continue;
        }

        try {
          const tempDest = `${destination}.tmp.${
            Math.random().toString(36).slice(2)
          }`;
          await Deno.copyFile(source, tempDest);
          try {
            await Deno.chmod(tempDest, 0o600);
          } catch {
            // ignore chmod errors on unsupported OS / filesystems
          }
          await Deno.rename(tempDest, destination);
          try {
            await Deno.chmod(destination, 0o600);
          } catch {
            // ignore chmod errors
          }
          synced.push({
            repo: repository.name,
            file: fileEntry.name,
            destination,
            action: destExists ? "OVERWRITTEN" : "CREATED",
          });
        } catch (err) {
          synced.push({
            repo: repository.name,
            file: fileEntry.name,
            destination,
            action: "FAILED",
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
  return synced;
}
