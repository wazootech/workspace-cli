export interface RepositoryEntry {
  name: string;
  url: string;
  /** Optional path relative to the workspace root. "." maps to the workspace root itself. */
  path?: string;
  /** Optional slices, e.g. ["beta"]. Unused by v1 commands except as manifest metadata. */
  groups?: string[];
  /** Optional extra local-config filename patterns to sync from the vault. */
  localFiles?: string[];
  /** Name of the sub-workspace this repo belongs to (set in resolved view). */
  workspace?: string;
}

/** Entry in the `workspaces` array pointing to a child manifest. */
export interface WorkspaceEntry {
  /** Human-readable name for this sub-workspace. */
  name: string;
  /** Path to the child workspace.json, relative to this manifest's directory. */
  path: string;
}

export interface WorkspaceManifest {
  schemaVersion?: number;
  /** Optional override of the manifest directory as the workspace root. */
  workspaceRoot?: string;
  repositoriesDirectory?: string;
  worktreesDirectory?: string;
  vaultDirectory?: string;
  repositories: RepositoryEntry[];
  /** Child workspace manifests (schema v2+). Each entry points to a nested workspace.json. */
  workspaces?: WorkspaceEntry[];
}

/** Flattened view combining parent + all child workspace repositories. */
export interface ResolvedWorkspace {
  /** The root (parent) manifest. */
  root: WorkspaceManifest;
  /** All child manifests keyed by workspace name. */
  children: Map<string, WorkspaceManifest>;
  /** Flattened repository list with workspace attribution. */
  repositories: RepositoryEntry[];
}

export interface WorkspaceConflict {
  repoName: string;
  claimedBy: string[];
}

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
      | "FAST_FORWARD_FAILED";
    name: string;
    detail?: string;
  }
  | { kind: "FAST_FORWARD"; name: string; commits: number };
