import { dirname, isAbsolute, normalize, resolve } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { exists } from "@std/fs";
import type {
  RepositoryEntry,
  ResolvedWorkspace,
  WorkspaceConflict,
  WorkspaceManifest,
} from "./types.ts";
import { validateSafeName } from "./validate.ts";

export const CURRENT_SCHEMA_VERSION = 4;

export const DEFAULT_MANIFEST_FILENAMES = ["workspace"];

/** Supported manifest formats by file extension, in discovery priority order. */
export const MANIFEST_EXTENSIONS = [".json", ".jsonc"];

export interface ManifestPaths {
  root: string;
  repositoriesDirectory: string;
  worktreesDirectory: string;
  secretsDirectory: string;
  /** Resolve the on-disk path for a repository entry. */
  resolveRepo(repo: { name: string; resolvedPath?: string }): string;
}

/** Find an existing workspace manifest inside a directory, honoring the default name/extension discovery order. */
export async function findExistingManifest(
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
  return (await findExistingManifest(cwd)) ??
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
      `Manifest ${manifestPath}: "workspaces" was removed in schema v4. Declare each child workspace's repositories directly in the parent manifest.`,
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
          `${at} sets "${key}", which is not supported in schema v4. Entries are either bare strings or { "name", "url" }.`,
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
export function expandShorthand(
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
  };
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

/**
 * Parse, normalize, and validate raw manifest text without touching the
 * filesystem. Used by manifest-editing commands to prove a rewritten
 * document is valid before it is written back.
 */
export function validateManifestText(
  raw: string,
  manifestPath: string,
): WorkspaceManifest {
  const parsed = parseManifestText(manifestPath, raw);
  const normalized = normalizeManifest(parsed, manifestPath);
  validateManifest(normalized);
  return normalized;
}

function resolveRepositoryPath(
  repository: { name: string; resolvedPath?: string },
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

  const paths: ManifestPaths = {
    root,
    repositoriesDirectory: dirOption(manifest.repositoriesDirectory, "repos"),
    worktreesDirectory: dirOption(manifest.worktreesDirectory, "worktrees"),
    secretsDirectory: dirOption(manifest.secretsDirectory, "secrets"),
    resolveRepo(repo: { name: string; resolvedPath?: string }): string {
      return resolveRepositoryPath(repo, paths);
    },
  };
  return paths;
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
 * Resolve the workspace tree: flatten the repo list from the manifest with
 * workspace attribution. Each repository's path is resolved against the
 * workspace's configured directories.
 */
export function resolveWorkspaceTree(
  manifest: WorkspaceManifest,
  manifestPath: string,
): ResolvedWorkspace {
  const paths = manifestPaths(manifest, manifestPath);
  const repositories = manifest.repositories.map((repo) => ({
    ...repo,
    workspace: undefined as string | undefined,
    resolvedPath: paths.resolveRepo(repo),
  }));
  return { root: manifest, repositories };
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

  // Group repos by workspace name.
  const byWorkspace = new Map<string, RepositoryEntry[]>();
  for (const repo of resolved.repositories) {
    if (repo.workspace) {
      const existing = byWorkspace.get(repo.workspace) ?? [];
      existing.push(repo);
      byWorkspace.set(repo.workspace, existing);
    }
  }

  for (const [name, repos] of byWorkspace) {
    result.push({ name, repos: repos.length, child: true });
  }

  return result;
}
