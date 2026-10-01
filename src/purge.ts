/**
 * Directory purge used as the fallback when `git worktree remove` fails.
 *
 * On Windows, removing a worktree whose path exceeds MAX_PATH fails with
 * "Filename too long" and leaves the directory (and its `.git` file) behind,
 * so the worktree stays registered and the branch stays locked. Git's own
 * removal cannot recover from this; the directory has to go first.
 *
 * Strategies are tried in increasing order of intrusiveness, and the one that
 * actually worked is reported so callers and users can see what happened.
 */

/** Convert a path to a Windows verbatim (`\\?\`) path, bypassing MAX_PATH. */
function verbatim(path: string): string {
  if (path.startsWith("\\\\?\\")) return path;
  if (path.startsWith("\\\\")) return `\\\\?\\UNC\\${path.slice(2)}`;
  return `\\\\?\\${path}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirror an empty directory over `target` with robocopy, which deletes
 * long-path contents the Win32 APIs refuse to touch, then rmdir the shell.
 * The empty source is created under the OS temp dir, not beside the target.
 */
async function robocopyPurge(target: string): Promise<boolean> {
  const empty = await Deno.makeTempDir({ prefix: "wspace-purge-" });
  try {
    // robocopy exit codes 0-7 are success; 8+ are real failures.
    const copy = await new Deno.Command("robocopy", {
      args: [
        empty,
        target,
        "/MIR",
        "/NFL",
        "/NDL",
        "/NJH",
        "/NP",
        "/R:1",
        "/W:1",
      ],
      stdout: "null",
      stderr: "null",
    }).output();
    if (copy.success === false && copy.code > 7) return false;
  } catch {
    return false;
  } finally {
    try {
      await Deno.remove(empty, { recursive: true });
    } catch {
      // The empty staging dir is disposable; a leftover temp dir must not
      // fail the purge that already succeeded.
    }
  }
  try {
    await new Deno.Command("rmdir", {
      args: [verbatim(target)],
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // Fall through to the existence check below.
  }
  return !(await exists(target));
}

/**
 * Delete `dir` and everything under it, returning the strategy that worked.
 * Returns undefined when the directory could not be removed, so callers can
 * report a failure rather than assume success.
 */
export async function purgeDirectory(
  dir: string,
): Promise<string | undefined> {
  // Strategy 1: a plain recursive delete. On non-Windows platforms, and for
  // most Windows paths, this is all that is needed.
  try {
    await Deno.remove(dir, { recursive: true });
    return "recursive delete";
  } catch {
    // Fall through to the long-path strategies.
  }

  if (Deno.build.os === "windows") {
    // Strategy 2: the verbatim prefix opts out of MAX_PATH normalisation.
    try {
      await Deno.remove(verbatim(dir), { recursive: true });
      return "verbatim recursive delete";
    } catch {
      // Fall through to robocopy.
    }

    // Strategy 3: robocopy mirrors the tree away, then rmdir removes the
    // now-empty directory through the verbatim path.
    if (await robocopyPurge(dir)) {
      return "robocopy mirror";
    }
    return undefined;
  }

  // POSIX last resort: rm -rf tolerates paths Deno refuses to resolve.
  try {
    const rm = await new Deno.Command("rm", {
      args: ["-rf", dir],
      stdout: "null",
      stderr: "null",
    }).output();
    if (rm.success) return "rm -rf";
  } catch {
    // Report failure below.
  }
  return undefined;
}
