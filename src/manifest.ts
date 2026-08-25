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
 * Entry keys removed in schema v4.1, rejected with pointed migration
 * messages instead of being silently ignored.
 */
const EVICTED_ENTRY_KEYS = [
  "path",
  "groups",
  "localFiles",
  "manifest",
] as const;

/**
 * Normalize a parsed manifest document into a WorkspaceManifest. Expands
 * shorthand repository entries — bare strings, "owner/name" strings, and
 * { name, owner } objects — against the manifest's host (default
 * github.com), and rejects keys removed in schema v4 with pointed migration
 * messages.
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
      `Manifest ${manifestPath}: "workspaces" was removed in schema v4. Declare each child workspace's repositories directly, or rely on auto-composition: a cloned repository containing its own manifest composes automatically.`,
    );
  }
  const owner = doc.owner;
  if (owner !== undefined && (typeof owner !== "string" || owner === "")) {
    throw new Error(
      `Manifest ${manifestPath}: "owner" must be a non-empty string when present.`,
    );
  }
  const host = doc.host ?? "github.com";
  if (
    typeof host !== "string" || host === "" || host.includes("://") ||
    host.includes("/")
  ) {
    throw new Error(
      `Manifest ${manifestPath}: "host" must be a bare hostname such as "github.com" (no protocol, no slashes).`,
    );
  }

  const repositories = (doc.repositories as unknown[]).map((entry, index) => {
    const at = `Manifest ${manifestPath}: repositories[${index}]`;
    if (typeof entry === "string") {
      return expandShorthand(at, entry, owner, host);
    }
    const record = entry as Record<string, unknown>;
    for (const key of EVICTED_ENTRY_KEYS) {
      if (record[key] !== undefined) {
        throw new Error(
          `${at} sets "${key}", which is not supported in schema v4. Entries are either bare strings or { "name", "url" }; sub-workspaces compose automatically when a repository contains its own manifest.`,
        );
      }
    }
    if (record.owner === undefined) {
      return entry as RepositoryEntry;
    }
    if (record.url !== undefined && record.url !== "") {
      throw new Error(
        `${at} sets both "url" and "owner"; they are mutually exclusive - use "url" for an explicit clone target or "owner" to expand against the host.`,
      );
    }
    const entryOwner = record.owner;
    if (typeof entryOwner !== "string" || entryOwner === "") {
      throw new Error(`${at}: "owner" must be a non-empty string.`);
    }
    return expandShorthand(
      at,
      typeof record.name === "string" ? record.name : "",
      typeof entryOwner === "string" ? entryOwner : undefined,
      host,
    );
  });
  return { ...(doc as Partial<WorkspaceManifest>), repositories };
}

/** Expand a shorthand ("name" or "owner/name") to a full repository entry. */
function expandShorthand(
  at: string,
  rawName: string,
  fallbackOwner: string | undefined,
  host: string,
): RepositoryEntry {
  let name = rawName;
  let entryOwner = fallbackOwner;
  const slashCount = (rawName.match(/\//g) ?? []).length;
  if (slashCount > 1) {
    throw new Error(
      `${at} ("${rawName}") contains multiple slashes; use exactly "owner/name".`,
    );
  }
  if (slashCount === 1) {
    const [inlineOwner, ...rest] = rawName.split("/");
    name = rest.join("/");
    if (!inlineOwner || !name) {
      throw new Error(
        `${at} ("${rawName}") must be "owner/name" with both halves non-empty.`,
      );
    }
    entryOwner = inlineOwner;
  }
  if (!entryOwner) {
    throw new Error(
      `${at} ("${rawName}") is a shorthand, which requires "owner" so it can expand to https://${host}/<owner>/${name}.`,
    );
  }
  validateSafeName(name, "Repository name");
  return {
    name,
    url: `https://${host}/${entryOwner}/${name}.git`,
    autoCompose: true,
  };
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

function requiredEntryMessage(repository: unknown): string {
  return `Repository entries are either bare strings or { "name", "url" }: ${
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
    if (!repository.name || !repository.url) {
      throw new Error(requiredEntryMessage(repository));
    }
    registerName(seen, repository.name, "Repository name");
  }
}

export function resolveRepositoryPath(
  repository: RepositoryEntry,
  paths: ManifestPaths,
): string {
  if (repository.resolvedPath !== undefined) {
    return normalize(resolve(repository.resolvedPath));
  }
  return normalize(resolve(paths.repositoriesDirectory, repository.name));
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
 * Resolve the workspace tree: load the root manifest, then recursively load
 * every sub-workspace detected on disk under bare-string entries whose
 * checkout contains a workspace manifest. Flatten the repo list with
 * workspace attribution. Repositories declared by a sub-workspace resolve
 * their paths against that sub-workspace's own root. Throws on circular
 * manifest references; a detected manifest that was already visited degrades
 * silently to a plain repository row.
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
    const detectedChildren: { name: string; path: string }[] = [];
    for (const repo of wsManifest.repositories) {
      const resolvedRow: RepositoryEntry = {
        ...repo,
        workspace: workspaceName,
        resolvedPath: resolveRepositoryPath(repo, wsPaths),
      };
      allRepos.push(resolvedRow);

      // Schema v4 auto-composition: bare-string entries may be workspaces.
      // Detection happens at the entry's checkout root and only after the
      // container exists on disk; objects never compose implicitly.
      if (repo.autoCompose) {
        const detectedPath = await discoverManifest(
          resolvedRow.resolvedPath!,
        );
        if (detectedPath === undefined) continue;
        const detectedDir = normalize(
          resolve(dirname(resolve(detectedPath))),
        );
        // Already part of this resolution tree (e.g. a repository that hosts
        // its own root manifest): degrade silently to a plain leaf row.
        if (visitedManifestDirs.has(detectedDir)) continue;
        detectedChildren.push({
          name: repo.name,
          path: normalize(detectedPath),
        });
      }
    }

    for (const child of detectedChildren) {
      if (children.has(child.name)) {
        throw new Error(`Duplicate workspace name: ${child.name}`);
      }
      const childManifest = await loadManifest(child.path);
      children.set(child.name, childManifest);
      await collectWorkspace(
        childManifest,
        child.path,
        child.name,
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
