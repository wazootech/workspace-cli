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
  resolveRepositoryPath,
  validateManifest,
} from "./manifest.ts";
export type { ManifestPaths } from "./manifest.ts";
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
  WorkspaceManifest,
  Worktree,
} from "./types.ts";
