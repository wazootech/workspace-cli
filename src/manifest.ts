import { dirname, isAbsolute, normalize, resolve } from "@std/path";
import type {
  RepositoryEntry,
  ResolvedWorkspace,
  WorkspaceConflict,
  WorkspaceEntry,
  WorkspaceManifest,
} from "./types.ts";
import { isWorkspaceReference } from "./types.ts";

export const CURRENT_SCHEMA_VERSION = 3;

export const DEFAULT_MANIFEST_FILENAMES = [
  "workspace.json",
  "wspace.json",
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

function requiredEntryMessage(repository: RepositoryEntry): string {
  return `Repository entries require name and url, or name and manifest: ${
    JSON.stringify(repository)
  }`;
}

function registerName(
  seen: Set<string>,
  name: string,
  contextName: string,
): void {
  validateSafeName(name, contextName);
  if (seen.has(name)) {
    throw new Error(`Duplicate ${contextName.toLowerCase()}: ${name}`);
  }
  seen.add(name);
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
    if (isWorkspaceReference(repository)) {
      if (
        repository.url !== undefined || repository.path !== undefined ||
        repository.groups !== undefined || repository.localFiles !== undefined
      ) {
        throw new Error(
          `Sub-workspace reference cannot combine manifest with url, path, groups, or localFiles: ${
            JSON.stringify(repository)
          }`,
        );
      }
    } else if (!repository.name || !repository.url) {
      throw new Error(requiredEntryMessage(repository));
    }
    if (!repository.name) {
      throw new Error(requiredEntryMessage(repository));
    }
    registerName(seen, repository.name, "Repository name");
  }
  if (manifest.workspaces) {
    const seenWorkspaces = new Set<string>();
    for (const ws of manifest.workspaces) {
      if (!ws.name || !ws.path) {
        throw new Error(
          `Workspace entries require name and path: ${JSON.stringify(ws)}`,
        );
      }
      registerName(seenWorkspaces, ws.name, "Workspace name");
    }
  }
}

export function resolveRepositoryPath(
  repository: RepositoryEntry,
  paths: ManifestPaths,
): string {
  if (repository.resolvedPath !== undefined) {
    return normalize(resolve(repository.resolvedPath));
  }
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

/**
 * Load a child workspace manifest relative to the parent manifest's directory.
 */
export async function loadChildManifest(
  parentManifestPath: string,
  entry: WorkspaceEntry,
): Promise<{ manifest: WorkspaceManifest; manifestPath: string }> {
  const parentDir = dirname(resolve(parentManifestPath));
  const childPath = normalize(resolve(parentDir, entry.path));
  if (!(await exists(childPath))) {
    throw new Error(
      `Sub-workspace "${entry.name}" manifest not found: ${childPath}`,
    );
  }
  const manifest = await loadManifest(childPath);
  return { manifest, manifestPath: childPath };
}

/**
 * Resolve the workspace tree: load the root manifest, then recursively load
 * every sub-workspace declared in `workspaces`, flatten the repo list with
 * workspace attribution, and detect conflicts. Repositories declared by a
 * sub-workspace resolve their paths against that sub-workspace's own root.
 * Throws on circular manifest references or duplicate workspace names.
 */
export async function resolveWorkspaceTree(
  manifest: WorkspaceManifest,
  manifestPath: string,
): Promise<ResolvedWorkspace> {
  const children = new Map<string, WorkspaceManifest>();
  const allRepos: RepositoryEntry[] = [];
  const visitedManifestDirs = new Set<string>();

  await collectWorkspace(manifest, manifestPath, undefined);

  return {
    root: manifest,
    children,
    repositories: allRepos,
  };

  async function collectWorkspace(
    wsManifest: WorkspaceManifest,
    wsManifestPath: string,
    workspaceName: string | undefined,
  ): Promise<void> {
    const manifestDir = normalize(resolve(dirname(resolve(wsManifestPath))));
    if (visitedManifestDirs.has(manifestDir)) {
      throw new Error(`Circular sub-workspace reference at: ${manifestDir}`);
    }
    visitedManifestDirs.add(manifestDir);

    const wsPaths = manifestPaths(wsManifest, wsManifestPath);
    // Schema v3+: sub-workspace references live inline in repositories;
    // schema v2 style declares them in a separate workspaces array. Both
    // forms are honored, inline first.
    const workspaceRefs: WorkspaceEntry[] = [];
    for (const repo of wsManifest.repositories) {
      if (isWorkspaceReference(repo)) {
        workspaceRefs.push({ name: repo.name, path: repo.manifest });
        continue;
      }
      allRepos.push({
        ...repo,
        workspace: workspaceName,
        resolvedPath: resolveRepositoryPath(repo, wsPaths),
      });
    }

    for (
      const wsEntry of [
        ...workspaceRefs,
        ...(wsManifest.workspaces ?? []),
      ]
    ) {
      if (children.has(wsEntry.name)) {
        throw new Error(`Duplicate workspace name: ${wsEntry.name}`);
      }
      const loaded = await loadChildManifest(wsManifestPath, wsEntry);
      children.set(wsEntry.name, loaded.manifest);
      await collectWorkspace(
        loaded.manifest,
        loaded.manifestPath,
        wsEntry.name,
      );
    }
  }
}

/**
 * Detect conflicts: repos claimed by more than one workspace.
 */
export function detectConflicts(
  resolved: ResolvedWorkspace,
): WorkspaceConflict[] {
  const claims = new Map<string, string[]>();
  for (const repo of resolved.repositories) {
    const wsName = repo.workspace ?? "(root)";
    const existing = claims.get(repo.name) ?? [];
    existing.push(wsName);
    claims.set(repo.name, existing);
  }
  const conflicts: WorkspaceConflict[] = [];
  for (const [repoName, claimedBy] of claims) {
    if (claimedBy.length > 1) {
      conflicts.push({ repoName, claimedBy });
    }
  }
  return conflicts;
}

/**
 * List sub-workspaces with their repo counts and manifest paths.
 */
export function listWorkspaces(
  resolved: ResolvedWorkspace,
): { name: string; repos: number; child: boolean }[] {
  const result: { name: string; repos: number; child: boolean }[] = [];

  // Root workspace (repos without workspace attribution).
  const rootRepos = resolved.repositories.filter((r) => !r.workspace);
  if (rootRepos.length > 0) {
    result.push({ name: "(root)", repos: rootRepos.length, child: false });
  }

  for (const [name, _child] of resolved.children) {
    const childRepos = resolved.repositories.filter(
      (r) => r.workspace === name,
    );
    result.push({ name, repos: childRepos.length, child: true });
  }

  return result;
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
