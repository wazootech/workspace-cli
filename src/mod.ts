export {
  addWorktree,
  listWorktrees,
  parseWorktreesPorcelain,
  removeWorktree,
} from "./worktrees.ts";
export { isLocalConfigFile, syncEnv } from "./env.ts";
export type { SyncEnvResult } from "./env.ts";
export { run } from "./cli.ts";
export { SystemGit } from "./git.ts";
export type { AheadBehind, GitResult, GitRunner } from "./git.ts";
export {
  CURRENT_SCHEMA_VERSION,
  loadManifest,
  manifestPaths,
  validateManifest,
} from "./manifest.ts";
export type { ManifestPaths } from "./manifest.ts";
export { resolveRepository } from "./resolve.ts";
export type { Repository } from "./resolve.ts";
export {
  classifyState,
  collectStatus,
  hasErrors,
  repoStatus,
} from "./status.ts";
export type { ClassifyInput } from "./status.ts";
export type {
  RepositoryEntry,
  RepoState,
  RepoStatus,
  UpdateAction,
  WorkspaceContext,
  WorkspaceManifest,
  Worktree,
} from "./types.ts";
