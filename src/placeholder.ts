/**
 * Placeholder detection for `wspace install --force`.
 *
 * A path that blocks a clone is only safe to clear when clearing cannot lose
 * data. The rule is deliberately narrow: the path must be a real directory
 * (never a symlink or a file) whose whole tree consists of directories, with
 * no file, symlink, or any other entry anywhere inside. Removal is bottom-up
 * `rmdir`, which the OS refuses for a non-empty directory, so even a file that
 * appears between the scan and the removal survives.
 */

import { join } from "@std/path";
import {
  isRealDirectory,
  readDirectory,
  removeEmptyDirectory,
} from "@/runtime.ts";

/**
 * Why `path` cannot be cleared as a placeholder, or undefined when it can.
 * Walks the tree; the first entry that is not a plain directory decides.
 */
export async function placeholderBlocker(
  path: string,
): Promise<string | undefined> {
  if (!(await isRealDirectory(path))) {
    return "is a file or symbolic link, not a directory";
  }
  const found = await firstContent(path);
  return found === undefined
    ? undefined
    : `contains ${found.slice(path.length + 1) || found}`;
}

async function firstContent(dir: string): Promise<string | undefined> {
  for (const entry of await readDirectory(dir)) {
    const entryPath = join(dir, entry.name);
    // Dirent reports a symlink as not-a-directory, so links count as content.
    if (!entry.isDirectory) return entryPath;
    const nested = await firstContent(entryPath);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** Remove a tree that {@link placeholderBlocker} accepted, deepest first. */
export async function clearPlaceholder(dir: string): Promise<void> {
  for (const entry of await readDirectory(dir)) {
    await clearPlaceholder(join(dir, entry.name));
  }
  await removeEmptyDirectory(dir);
}
