/**
 * Re-exports from focused modules. This file preserves backwards
 * compatibility — existing `import { ... } from "./shared.ts"` continue
 * to work. New code should import from the focused modules directly:
 *
 * - cli-options.ts — CLI option types
 * - output.ts — output formatting and scoping
 * - manifest-load.ts — manifest loading and editing helpers
 */

// CLI options
export type { CliOptions } from "./cli-options.ts";

// Output formatting
export { flattenResolved, printRows, scopeManifest } from "./output.ts";

// Manifest loading
export {
  applyEntryEdit,
  loadEditableManifest,
  manifestExtension,
  resolveManifestPath,
} from "./manifest-load.ts";
export type { EditableManifest, EditRow } from "./manifest-load.ts";
