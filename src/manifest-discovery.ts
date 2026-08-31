import { dirname, resolve } from "@std/path";
import { exists } from "@std/fs";

export const CURRENT_SCHEMA_VERSION = 4;

export const DEFAULT_MANIFEST_FILENAMES = ["workspace"];

/** Supported manifest formats by file extension, in discovery priority order. */
export const MANIFEST_EXTENSIONS = [".json"];

/** Find an existing workspace manifest inside a directory, honoring the default name/extension discovery order. */
export async function findExistingManifest(
  dir: string,
): Promise<string | undefined> {
  for (const basename of DEFAULT_MANIFEST_FILENAMES) {
    for (const extension of MANIFEST_EXTENSIONS) {
      const candidate = resolve(dir, basename + extension);
      if (await exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Walk up from `startDir` toward the filesystem root, returning the first
 * existing workspace manifest found. This mirrors the git rev-parse
 * --show-toplevel pattern: workspace commands work from any subdirectory
 * of the workspace without requiring an explicit --manifest flag.
 *
 * Returns undefined when no manifest is found before reaching the root
 * (or the filesystem boundary).
 */
export async function findManifestWalkingUp(
  startDir: string,
): Promise<string | undefined> {
  let dir = startDir;
  while (true) {
    const found = await findExistingManifest(dir);
    if (found) return found;

    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root reached
    dir = parent;
  }
  return undefined;
}

export async function findDefaultManifestPath(
  cwd: string = Deno.cwd(),
): Promise<string> {
  return (await findManifestWalkingUp(cwd)) ??
    resolve(cwd, DEFAULT_MANIFEST_FILENAMES[0] + MANIFEST_EXTENSIONS[0]);
}
