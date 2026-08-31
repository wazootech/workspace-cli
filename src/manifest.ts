/**
 * Re-exports from focused manifest modules. This file preserves backwards
 * compatibility — existing `import { ... } from "./manifest.ts"` continue
 * to work. New code should import from the focused modules directly:
 *
 * - manifest-discovery.ts — finding manifest files on disk
 * - manifest-normalize.ts — parsing, normalizing, validating manifests
 * - manifest-paths.ts — resolving workspace directory paths
 * - workspace-tree.ts — building the resolved workspace tree
 */

// Discovery
export {
  DEFAULT_MANIFEST_FILENAMES,
  findDefaultManifestPath,
  findExistingManifest,
  findManifestWalkingUp,
  MANIFEST_EXTENSIONS,
} from "./manifest-discovery.ts";

// Current schema version lives in discovery (used by normalize for validation)
export { CURRENT_SCHEMA_VERSION } from "./manifest-discovery.ts";

// Normalization, validation, loading
export {
  loadManifest,
  normalizeManifest,
  parseManifestText,
  validateManifest,
  validateManifestText,
  validateSafeName,
} from "./manifest-normalize.ts";
export type { RawManifest } from "./manifest-normalize.ts";

// Path resolution
export { manifestPaths, resolveRepositoryPath } from "./manifest-paths.ts";
export type { ManifestPaths } from "./manifest-paths.ts";

// Workspace tree
export {
  detectConflicts,
  listWorkspaces,
  resolveWorkspaceTree,
} from "./workspace-tree.ts";
