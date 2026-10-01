/** Display name for the workspace's own checkout (the directory hosting the manifest). */
export const ROOT_LABEL = "(workspace root)";

export type UpdateAction =
  | { kind: "MISSING"; name: string }
  | { kind: "INVALID"; name: string; detail?: string }
  | {
    kind:
      | "SKIP_DIRTY"
      | "SKIP_FEATURE"
      | "SKIP_NO_DEFAULT"
      | "SKIP_AHEAD"
      | "CURRENT"
      | "FETCH_FAILED"
      | "FAST_FORWARD_FAILED"
      | "WOULD_FAST_FORWARD";
    name: string;
    detail?: string;
  }
  | { kind: "FAST_FORWARD"; name: string; commits: number };

/**
 * One row of a `wspace sweep` plan or result. A row describes a single
 * candidate worktree in a single repository; a repository with no candidate
 * worktrees produces no rows at all.
 */
export type SweepAction =
  | {
    kind: "REMOVED" | "WOULD_REMOVE";
    name: string;
    branch: string;
    worktree: string;
    /** How the merge was proven, or why --force was needed. */
    detail?: string;
  }
  | {
    kind:
      | "SKIP_NOT_MERGED"
      | "SKIP_DIRTY"
      | "SKIP_DETACHED"
      | "SKIP_DEFAULT"
      | "SKIP_NO_DEFAULT"
      | "FAILED"
      | "SKIPPED_REMOTE";
    name: string;
    branch?: string;
    worktree?: string;
    detail?: string;
  };

/** A mutation that broke, as opposed to a refusal to act. */
export function isSweepFailure(action: SweepAction): boolean {
  return action.kind === "FAILED";
}

export type RepoState =
  | "MISSING"
  | "INVALID"
  | "PATH_BLOCKED"
  | "DIRTY"
  | "FEATURE_CLEAN"
  | "DIVERGED"
  | "CLEAN"
  | "UNKNOWN"
  | "ERROR";

export interface RepoStatus {
  name: string;
  path: string;
  branch?: string;
  defaultBranch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  state: RepoState;
  detail?: string;
}

/** Minimal workspace context needed for repository resolution. */
export interface WorkspaceContext {
  host?: string;
  owner?: string;
}

export interface RepositoryEntry {
  name: string;
  /** Clone URL. Any Git host; shorthand entries expand to GitHub-style HTTPS. */
  url: string;
  /** Absolute path resolved from the owning workspace's root (set in the resolved view). */
  resolvedPath?: string;
  /** Name of the sub-workspace this repo belongs to (set in resolved view). */
  workspace?: string;
  /** Internal marker for entries declared in the manifest's workspaces array. */
  isWorkspace?: boolean;
  /** Why this workspace entry could not be resolved (set in resolved view). */
  error?: string;
}

/** A workspace manifest: the config document the wspace CLI reads. */
export interface WorkspaceManifest {
  schemaVersion?: number;
  /**
   * GitHub-compatible owner for shorthand repository entries (bare strings,
   * "owner/name" strings, and { name, owner } objects). A shorthand expands
   * to https://<host>/<owner>/<name>.
   */
  owner?: string;
  /**
   * Host for shorthand expansion, hostname only (schema v4+). Defaults to
   * github.com.
   */
  host?: string;
  /** Optional override of the manifest directory as the workspace root. */
  workspaceRoot?: string;
  repositoriesDirectory?: string;
  /** Directory (relative to workspaceRoot) for workspace repository checkouts. Defaults to repositoriesDirectory. */
  workspacesDirectory?: string;
  repositories: RepositoryEntry[];
  /** Repositories that must contain a valid child workspace manifest. */
  workspaces?: RepositoryEntry[];
}

/** Resolved view of the workspace: the root manifest and all repositories. */
export interface ResolvedWorkspace {
  /** The root manifest. */
  root: WorkspaceManifest;
  /** Child workspace manifests keyed by their declared repository name. */
  children?: Map<string, WorkspaceManifest>;
  /** Workspace entries discovered in the manifest tree. */
  workspaceEntries?: RepositoryEntry[];
  /** All repositories with workspace attribution. */
  repositories: RepositoryEntry[];
}

export interface WorkspaceConflict {
  repoName: string;
  /** The checkout path shared by the conflicting entries. */
  path: string;
  claimedBy: string[];
}
