import { dirname, isAbsolute, normalize, resolve } from "@std/path";
import type { WorkspaceManifest } from "./types.ts";

export interface ManifestPaths {
  root: string;
  repositoriesDirectory: string;
}

/**
 * Resolve the on-disk path for a repository entry. Uses a pre-set
 * `resolvedPath` when available, otherwise computes it from the
 * workspace's repositories directory.
 */
export function resolveRepositoryPath(
  repo: { name: string; resolvedPath?: string },
  paths: ManifestPaths,
): string {
  if (repo.resolvedPath !== undefined) {
    return normalize(resolve(repo.resolvedPath));
  }
  return normalize(resolve(paths.repositoriesDirectory, repo.name));
}

export function manifestPaths(
  manifest: WorkspaceManifest,
  manifestPath: string,
): ManifestPaths {
  const manifestDir = dirname(resolve(manifestPath));
  const rawRoot = manifest.workspaceRoot ?? manifestDir;
  const root = isAbsolute(rawRoot)
    ? normalize(resolve(rawRoot))
    : normalize(resolve(manifestDir, rawRoot));

  // Resolve a configured directory against the workspace root, falling back
  // to a conventional default.
  const dirOption = (value: string | undefined, fallback: string): string => {
    if (!value) return normalize(resolve(root, fallback));
    return isAbsolute(value)
      ? normalize(resolve(value))
      : normalize(resolve(root, value));
  };

  const paths: ManifestPaths = {
    root,
    repositoriesDirectory: dirOption(manifest.repositoriesDirectory, "repos"),
  };
  return paths;
}
