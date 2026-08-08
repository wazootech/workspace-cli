export interface RepositoryEntry {
  name: string;
  url: string;
  /** Optional path relative to the workspace root. "." maps to the workspace root itself. */
  path?: string;
  /** Optional slices, e.g. ["beta"]. Unused by v1 commands except as manifest metadata. */
  groups?: string[];
  /** Optional extra local-config filename patterns to sync from the vault. */
  localFiles?: string[];
}

export interface WorkspaceManifest {
  schemaVersion?: number;
  /** Optional override of the manifest directory as the workspace root. */
  workspaceRoot?: string;
  repositoriesDirectory?: string;
  worktreesDirectory?: string;
  vaultDirectory?: string;
  repositories: RepositoryEntry[];
}

export type RepoState =
  | "MISSING"
  | "INVALID"
  | "DIRTY"
  | "FEATURE_CLEAN"
  | "DIVERGED"
  | "CLEAN"
  | "UNKNOWN";

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
