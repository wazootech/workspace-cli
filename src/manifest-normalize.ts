import type { RepositoryEntry, WorkspaceManifest } from "./types.ts";
import { type Repository, resolveRepository } from "./resolve.ts";
import { CURRENT_SCHEMA_VERSION } from "./manifest-discovery.ts";
import { validateRepositoryName } from "./names.ts";

/** Raw repository entry — shorthand string or unvalidated object. */
type RawRepositoryEntry = string | Record<string, unknown>;

/**
 * Raw manifest shape as produced by JSON parsing. Repository entries
 * are either shorthand strings or unvalidated objects — normalization
 * resolves them into typed RepositoryEntry values.
 */
export interface RawManifest {
  schemaVersion?: number;
  owner?: string;
  host?: string;
  workspaceRoot?: string;
  repositoriesDirectory?: string;
  worktreesDirectory?: string;
  secretsDirectory?: string;
  repositories: Array<string | RawRepositoryEntry>;
}

export function parseManifestText(
  manifestPath: string,
  raw: string,
): RawManifest {
  const extension = manifestPath.slice(manifestPath.lastIndexOf("."))
    .toLowerCase();
  if (extension !== ".json") {
    throw new Error(
      `Unsupported manifest format "${extension}" (supported: .json)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse manifest ${manifestPath}: ${message}`);
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).repositories)
  ) {
    throw new Error(
      `Manifest ${manifestPath} must be an object with a repositories array`,
    );
  }
  return parsed as RawManifest;
}

/**
 * Normalize a parsed manifest document into a WorkspaceManifest. Expands
 * shorthand repository entries — bare strings, "owner/name" strings, and
 * { name, owner } objects — against the manifest's host (default
 * github.com).
 */
export function normalizeManifest(
  parsed: RawManifest,
  manifestPath: string,
): WorkspaceManifest {
  const doc = parsed;
  const raw = doc as unknown as Record<string, unknown>;
  if (raw.vaultDirectory !== undefined) {
    throw new Error(
      `Manifest ${manifestPath}: "vaultDirectory" was renamed to "secretsDirectory" in schema v4.`,
    );
  }
  if (raw.workspaces !== undefined) {
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

  const resolveEntry = (
    at: string,
    repo: string | Repository,
  ): RepositoryEntry => {
    try {
      return resolveRepository({ host, owner }, repo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${at}: ${message}`);
    }
  };

  const repositories = doc.repositories.map((entry, index) => {
    const at = `Manifest ${manifestPath}: repositories[${index}]`;
    if (typeof entry === "string") {
      return resolveEntry(at, entry);
    }
    if (entry.owner === undefined) {
      return {
        name: typeof entry.name === "string" ? entry.name : "",
        url: typeof entry.url === "string" ? entry.url : "",
      };
    }
    if (entry.url !== undefined && entry.url !== "") {
      throw new Error(
        `${at} sets both "url" and "owner"; they are mutually exclusive - use "url" for an explicit clone target or "owner" to expand against the host.`,
      );
    }
    if (typeof entry.owner !== "string" || entry.owner === "") {
      throw new Error(`${at}: "owner" must be a non-empty string.`);
    }
    return resolveEntry(at, {
      name: typeof entry.name === "string" ? entry.name : "",
      host: typeof entry.host === "string" ? entry.host : undefined,
      owner: entry.owner,
      url: typeof entry.url === "string" ? entry.url : undefined,
    });
  });
  return {
    schemaVersion: doc.schemaVersion,
    owner: doc.owner,
    host: doc.host,
    workspaceRoot: doc.workspaceRoot,
    repositoriesDirectory: doc.repositoriesDirectory,
    worktreesDirectory: doc.worktreesDirectory,
    secretsDirectory: doc.secretsDirectory,
    repositories,
  };
}

/**
 * Validate a repository name. Delegates to names.ts for GitHub-aligned rules.
 * Kept as an alias for backwards compatibility.
 */
export function validateSafeName(name: string, _contextName = "Name"): void {
  validateRepositoryName(name);
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
  validateRepositoryName(name);
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
