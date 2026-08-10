import { dirname, isAbsolute, normalize, resolve } from "@std/path";
import type { RepositoryEntry, WorkspaceManifest } from "./types.ts";

export const CURRENT_SCHEMA_VERSION = 1;

export const DEFAULT_MANIFEST_FILENAMES = [
  "wspace.json",
  "workspace.json",
  "repos.json",
];

export interface ManifestPaths {
  root: string;
  repositoriesDirectory: string;
  worktreesDirectory: string;
  vaultDirectory: string;
}

export async function findDefaultManifestPath(
  cwd: string = Deno.cwd(),
): Promise<string> {
  for (const filename of DEFAULT_MANIFEST_FILENAMES) {
    const candidate = resolve(cwd, filename);
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return resolve(cwd, DEFAULT_MANIFEST_FILENAMES[0]);
}

export function validateSafeName(name: string, contextName = "Name"): void {
  if (!name || typeof name !== "string" || name.trim() === "") {
    throw new Error(`${contextName} cannot be empty`);
  }
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".." ||
    name.includes("..")
  ) {
    throw new Error(
      `${contextName} "${name}" contains invalid characters or path traversal`,
    );
  }
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
    validateSafeName(repository.name, "Repository name");
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
    return normalize(resolve(paths.repositoriesDirectory, repository.name));
  }
  if (isAbsolute(repository.path)) {
    return normalize(resolve(repository.path));
  }
  return repository.path === "."
    ? paths.root
    : normalize(resolve(paths.root, repository.path));
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

  const repositoriesDirectory = manifest.repositoriesDirectory
    ? isAbsolute(manifest.repositoriesDirectory)
      ? normalize(resolve(manifest.repositoriesDirectory))
      : normalize(resolve(root, manifest.repositoriesDirectory))
    : normalize(resolve(root, "repos"));

  const worktreesDirectory = manifest.worktreesDirectory
    ? isAbsolute(manifest.worktreesDirectory)
      ? normalize(resolve(manifest.worktreesDirectory))
      : normalize(resolve(root, manifest.worktreesDirectory))
    : normalize(resolve(root, "worktrees"));

  const vaultDirectory = manifest.vaultDirectory
    ? isAbsolute(manifest.vaultDirectory)
      ? normalize(resolve(manifest.vaultDirectory))
      : normalize(resolve(root, manifest.vaultDirectory))
    : normalize(resolve(root, "secrets"));

  return {
    root,
    repositoriesDirectory,
    worktreesDirectory,
    vaultDirectory,
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
