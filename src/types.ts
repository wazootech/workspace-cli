export interface RepositoryEntry {
  name: string;
  /**
   * Clone URL. Required on leaf repositories. Optional on sub-workspace
   * references, where it promotes the reference to a managed repository:
   * init clones it before reading the child manifest.
   */
  url?: string;
  /**
   * Path to a child workspace manifest, relative to the declaring manifest's
   * directory (schema v3+). Marks this entry as a sub-workspace reference;
   * forbidden together with path, groups, and localFiles.
   */
  manifest?: string;
  /** Optional path relative to the workspace root of the manifest declaring it. "." maps to that root itself. */
  path?: string;
  /** Absolute path resolved from the owning workspace's root (set in the resolved view). */
  resolvedPath?: string;
  /** Optional slices, e.g. ["beta"]. Unused by v1 commands except as manifest metadata. */
  groups?: string[];
  /** Optional extra local-config filename patterns to sync from the vault. */
  localFiles?: string[];
  /**
   * Set when this entry was written as a bare string in schema v4. Such
   * entries auto-compose as a detected sub-workspace when their checkout
   * contains a workspace manifest. Internal marker; never authored by hand.
   */
  autoCompose?: boolean;
  /** Name of the sub-workspace this repo belongs to (set in resolved view). */
  workspace?: string;
}

/** Type guard: true when the entry is an inline sub-workspace reference. */
export function isWorkspaceReference(
  entry: RepositoryEntry,
): entry is RepositoryEntry & { manifest: string } {
  return entry.manifest !== undefined && entry.manifest !== "";
}

/** A workspace manifest: the config document the wspace CLI reads. */
export interface WorkspaceManifest {
  schemaVersion?: number;
  /**
   * GitHub owner for bare-string repository entries. A string entry "repo"
   * expands to https://github.com/<owner>/repo. Objects never consult owner.
   */
  owner?: string;
  /** Optional override of the manifest directory as the workspace root. */
  workspaceRoot?: string;
  repositoriesDirectory?: string;
  worktreesDirectory?: string;
  secretsDirectory?: string;
  repositories: RepositoryEntry[];
}

/** Flattened view combining parent + all child workspace repositories. */
export interface ResolvedWorkspace {
  /** The root (parent) manifest. */
  root: WorkspaceManifest;
  /** All child manifests keyed by workspace name. */
  children: Map<string, WorkspaceManifest>;
  /** Flattened repository list with workspace attribution. */
  repositories: RepositoryEntry[];
  /**
   * Sub-workspace references from every manifest in the tree, with checkout
   * paths resolved. References carrying a url are clone targets for init.
   */
  references: RepositoryEntry[];
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
