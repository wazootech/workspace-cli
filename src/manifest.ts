import { dirname, isAbsolute, join } from "@std/path";
import type { RepositoryEntry, WorkspaceManifest } from "./types.ts";

export const CURRENT_SCHEMA_VERSION = 1;

export interface ManifestPaths {
  root: string;
  repositoriesDirectory: string;
  worktreesDirectory: string;
  vaultDirectory: string;
}

export function validateManifest(manifest: WorkspaceManifest): void {
  if (
    manifest.schemaVersion !== undefined &&
    manifest.schemaVersion > CURRENT_SCHEMA_VERSION
  ) {
    throw new Error(
      `Manifest schema version ${manifest.schemaVersion} is newer than supported (${CURRENT_SCHEMA_VERSION})`,
    );
  }
  const seen = new Set<string>();
  for (const repository of manifest.repositories) {
    if (!repository.name || !repository.url) {
      throw new Error(
        `Repository entries require name and url: ${
          JSON.stringify(repository)
        }`,
      );
    }
    if (seen.has(repository.name)) {
      throw new Error(`Duplicate repository name: ${repository.name}`);
    }
    seen.add(repository.name);
  }
}

export function resolveRepositoryPath(
  repository: RepositoryEntry,
  paths: ManifestPaths,
): string {
  if (!repository.path) {
    return join(paths.repositoriesDirectory, repository.name);
  }
  if (isAbsolute(repository.path)) {
    return repository.path;
  }
  return repository.path === "."
    ? paths.root
    : join(paths.root, repository.path);
}

export function manifestPaths(
  manifest: WorkspaceManifest,
  manifestPath: string,
): ManifestPaths {
  const manifestDir = dirname(manifestPath);
  const root = manifest.workspaceRoot ?? manifestDir;
  return {
    root,
    repositoriesDirectory: join(
      root,
      manifest.repositoriesDirectory ?? "repos",
    ),
    worktreesDirectory: join(root, manifest.worktreesDirectory ?? "worktrees"),
    vaultDirectory: join(root, manifest.vaultDirectory ?? "secrets"),
  };
}

export async function loadManifest(
  manifestPath: string,
): Promise<WorkspaceManifest> {
  const raw = JSON.parse(await Deno.readTextFile(manifestPath));
  validateManifest(raw);
  return raw as WorkspaceManifest;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}
