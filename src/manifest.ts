import { dirname, isAbsolute, normalize, resolve } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { parse as parseYaml } from "@std/yaml";
import { exists } from "@std/fs";
import type {
  RepositoryEntry,
  ResolvedWorkspace,
  WorkspaceConflict,
  WorkspaceManifest,
} from "./types.ts";
import { isWorkspaceReference } from "./types.ts";

export const CURRENT_SCHEMA_VERSION = 4;

export const DEFAULT_MANIFEST_FILENAMES = [
  "workspace",
  "wspace",
  "repos",
];

/** Supported manifest formats by file extension, in discovery priority order. */
export const MANIFEST_EXTENSIONS = [".json", ".jsonc", ".yaml", ".yml"];

export interface ManifestPaths {
  root: string;
  repositoriesDirectory: string;
  worktreesDirectory: string;
  secretsDirectory: string;
}

/** A declared sub-workspace manifest file does not exist on disk. */
export class MissingManifestError extends Error {
  constructor(
    readonly workspaceName: string,
    readonly manifestPath: string,
  ) {
    super(
      `Sub-workspace "${workspaceName}" manifest not found: ${manifestPath}`,
    );
    this.name = "MissingManifestError";
  }
}

/** Find an existing workspace manifest inside a directory, honoring the default name/extension discovery order. */
async function discoverManifest(
  dir: string,
): Promise<string | undefined> {
  for (const basename of DEFAULT_MANIFEST_FILENAMES) {
    for (const extension of MANIFEST_EXTENSIONS) {
      const candidate = resolve(dir, basename + extension);
      if (await exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export async function findDefaultManifestPath(
  cwd: string = Deno.cwd(),
): Promise<string> {
  return (await discoverManifest(cwd)) ??
    resolve(cwd, DEFAULT_MANIFEST_FILENAMES[0] + MANIFEST_EXTENSIONS[0]);
}

function parseManifestText(manifestPath: string, raw: string): unknown {
  const extension = manifestPath.slice(manifestPath.lastIndexOf("."))
    .toLowerCase();
  let parsed: unknown;
  try {
    switch (extension) {
      case ".json":
        parsed = JSON.parse(raw);
        break;
      case ".jsonc":
        parsed = parseJsonc(raw);
        break;
      case ".yaml":
      case ".yml":
        parsed = parseYaml(raw);
        break;
      default:
        throw new Error(
          `Unsupported manifest format "${extension}" (supported: ${
            MANIFEST_EXTENSIONS.join(", ")
          })`,
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse manifest ${manifestPath}: ${message}`);
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    !Array.isArray((parsed as { repositories?: unknown }).repositories)
  ) {
    throw new Error(
      `Manifest ${manifestPath} must be an object with a repositories array`,
    );
  }
  return parsed;
}

/**
 * Normalize a parsed manifest document into a WorkspaceManifest. Expands
 * bare-string repository entries against the manifest's owner, and rejects
 * keys removed in schema v4 with pointed migration messages.
 */
export function normalizeManifest(
  parsed: unknown,
  manifestPath: string,
): WorkspaceManifest {
  const doc = parsed as Record<string, unknown>;
  if (doc.vaultDirectory !== undefined) {
    throw new Error(
      `Manifest ${manifestPath}: "vaultDirectory" was renamed to "secretsDirectory" in schema v4.`,
    );
  }
  if (doc.workspaces !== undefined) {
    throw new Error(
      `Manifest ${manifestPath}: "workspaces" was removed in schema v4. Move each workspaces[] entry into repositories[] as { "name": "...", "manifest": "<path>" }.`,
    );
  }
  const owner = doc.owner;
  if (owner !== undefined && (typeof owner !== "string" || owner === "")) {
    throw new Error(
      `Manifest ${manifestPath}: "owner" must be a non-empty string when present.`,
    );
  }
  const repositories = (doc.repositories as unknown[]).map((entry, index) => {
    if (typeof entry === "string") {
      if (typeof owner !== "string") {
        throw new Error(
          `Manifest ${manifestPath}: repositories[${index}] ("${entry}") is a bare string, which requires "owner" so it can expand to https://github.com/<owner>/${entry}.`,
        );
      }
      return {
        name: entry,
        url: `https://github.com/${owner}/${entry}.git`,
        autoCompose: true,
      } satisfies RepositoryEntry;
    }
    return entry as RepositoryEntry;
  });
  return { ...(doc as Partial<WorkspaceManifest>), repositories };
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

function leafUrlMessage(repository: RepositoryEntry): string {
  return `Repository "${repository.name}" requires a url, or declare it as a bare string so it expands against "owner".`;
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
    if (!repository.name) {
      throw new Error(requiredEntryMessage(repository));
    }
    registerName(seen, repository.name, "Repository name");
    if (isWorkspaceReference(repository)) {
      if (
        repository.path !== undefined || repository.groups !== undefined ||
        repository.localFiles !== undefined
      ) {
        throw new Error(
          `Sub-workspace reference cannot combine manifest with path, groups, or localFiles: ${
            JSON.stringify(repository)
          }`,
        );
      }
      if (repository.url === "") {
        throw new Error(requiredEntryMessage(repository));
      }
      continue;
    }
    if (!repository.url) {
      throw repository.manifest === undefined
        ? new Error(leafUrlMessage(repository))
        : new Error(requiredEntryMessage(repository));
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

  // Resolve a configured directory against the workspace root, falling back
  // to a conventional default.
  const dirOption = (value: string | undefined, fallback: string): string => {
    if (!value) return normalize(resolve(root, fallback));
    return isAbsolute(value)
      ? normalize(resolve(value))
      : normalize(resolve(root, value));
  };

  return {
    root,
    repositoriesDirectory: dirOption(manifest.repositoriesDirectory, "repos"),
    worktreesDirectory: dirOption(manifest.worktreesDirectory, "worktrees"),
    secretsDirectory: dirOption(manifest.secretsDirectory, "secrets"),
  };
}

export async function loadManifest(
  manifestPath: string,
): Promise<WorkspaceManifest> {
  const raw = parseManifestText(
    manifestPath,
    await Deno.readTextFile(manifestPath),
  );
  const manifest = normalizeManifest(raw, manifestPath);
  validateManifest(manifest);
  return manifest;
}

/**
 * Load a child workspace manifest from an absolute path. The workspace name
 * is used only for error attribution.
 */
export async function loadChildManifestAt(
  workspaceName: string,
  childPath: string,
): Promise<{ manifest: WorkspaceManifest; manifestPath: string }> {
  if (!(await exists(childPath))) {
    throw new MissingManifestError(workspaceName, childPath);
  }
  const manifest = await loadManifest(childPath);
  return { manifest, manifestPath: childPath };
}

/**
 * Resolve the workspace tree: load the root manifest, then recursively load
 * every sub-workspace — declared inline via {name, manifest} references or
 * detected on disk under bare-string entries whose checkout contains a
 * workspace manifest. Flatten the repo list with workspace attribution.
 * Repositories declared by a sub-workspace resolve their paths against that
 * sub-workspace's own root. Throws on circular manifest references; a
 * detected manifest that was already visited degrades silently to a plain
 * repository row.
 */
export async function resolveWorkspaceTree(
  manifest: WorkspaceManifest,
  manifestPath: string,
): Promise<ResolvedWorkspace> {
  const children = new Map<string, WorkspaceManifest>();
  const allRepos: RepositoryEntry[] = [];
  const allReferences: RepositoryEntry[] = [];
  const visitedManifestDirs = new Set<string>();

  await collectWorkspace(manifest, manifestPath, undefined);

  return {
    root: manifest,
    children,
    repositories: allRepos,
    references: allReferences,
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
    const childRefs: { name: string; path: string }[] = [];
    for (const repo of wsManifest.repositories) {
      const resolvedRow: RepositoryEntry = {
        ...repo,
        workspace: workspaceName,
        resolvedPath: resolveRepositoryPath(repo, wsPaths),
      };
      if (isWorkspaceReference(repo)) {
        allReferences.push(resolvedRow);
        // Reference manifests resolve relative to the declaring manifest's
        // directory; detection below pushes absolute paths instead.
        const declaredDir = normalize(
          resolve(dirname(resolve(wsManifestPath))),
        );
        childRefs.push({
          name: repo.name,
          path: normalize(resolve(declaredDir, repo.manifest)),
        });
        continue;
      }
      allRepos.push(resolvedRow);

      // Schema v4 auto-composition: bare-string entries may be workspaces.
      // Detection happens at the entry's checkout root and only after the
      // container exists on disk; objects never compose implicitly.
      if (repo.autoCompose && resolvedRow.resolvedPath !== undefined) {
        const detectedPath = await discoverManifest(
          resolvedRow.resolvedPath,
        );
        if (detectedPath === undefined) continue;
        const detectedDir = normalize(
          resolve(dirname(resolve(detectedPath))),
        );
        // Already part of this resolution tree (e.g. a repository that hosts
        // its own root manifest): degrade silently to a plain leaf row.
        if (visitedManifestDirs.has(detectedDir)) continue;
        childRefs.push({ name: repo.name, path: normalize(detectedPath) });
      }
    }

    for (const ref of childRefs) {
      if (children.has(ref.name)) {
        throw new Error(`Duplicate workspace name: ${ref.name}`);
      }
      const loaded = await loadChildManifestAt(ref.name, ref.path);
      children.set(ref.name, loaded.manifest);
      await collectWorkspace(
        loaded.manifest,
        loaded.manifestPath,
        ref.name,
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
  const claimed = [...resolved.references, ...resolved.repositories];
  for (const repo of claimed) {
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
