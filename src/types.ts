export type UpdateAction =
  | { kind: "MISSING" | "INVALID"; name: string }
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

export type RepoState =
  | "MISSING"
  | "INVALID"
  | "PATH_BLOCKED"
  | "DIRTY"
  | "WORKTREE_DIRTY"
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
  isWorktree?: boolean;
  worktreePath?: string;
}

export interface Worktree {
  path: string;
  branch?: string;
  head?: string;
  bare: boolean;
  detached: boolean;
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
}

/** A workspace manifest: the config document the works CLI reads. */
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
  worktreesDirectory?: string;
  secretsDirectory?: string;
  repositories: RepositoryEntry[];
}

/** Resolved view of the workspace: the root manifest and all repositories. */
export interface ResolvedWorkspace {
  /** The root manifest. */
  root: WorkspaceManifest;
  /** All repositories with workspace attribution. */
  repositories: RepositoryEntry[];
}

export interface WorkspaceConflict {
  repoName: string;
  claimedBy: string[];
}
