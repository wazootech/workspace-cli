import { join } from "@std/path";
import { pathExists } from "@/runtime.ts";
import { clearPlaceholder, placeholderBlocker } from "@/placeholder.ts";
import type { InstallRow } from "@/commands/install-rows.ts";

/** What `install --force` did about whatever occupies a repository path. */
export type Clearance =
  | { kind: "none" }
  | { kind: "cleared" }
  | { kind: "row"; row: InstallRow };

/**
 * Clear a placeholder that blocks a clone, but only when that loses no data
 * (see `placeholder.ts`). A valid checkout and a missing path are left alone;
 * anything with content stays `PATH_BLOCKED` with the reason. Under `dryRun`
 * the placeholder is reported as `WOULD_CLEAR` and nothing is touched.
 */
export async function clearBlockingPath(
  name: string,
  repoPath: string,
  dryRun: boolean,
): Promise<Clearance> {
  if (!(await pathExists(repoPath))) return { kind: "none" };
  if (await pathExists(join(repoPath, ".git"))) return { kind: "none" };
  const blocker = await placeholderBlocker(repoPath);
  if (blocker !== undefined) {
    return {
      kind: "row",
      row: {
        name,
        state: "PATH_BLOCKED",
        detail:
          `Path exists but is not a Git repository and ${blocker}; --force only clears empty directories`,
      },
    };
  }
  if (dryRun) {
    return {
      kind: "row",
      row: {
        name,
        state: "WOULD_CLEAR",
        detail: "empty placeholder directory, then clone",
      },
    };
  }
  try {
    await clearPlaceholder(repoPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: "row",
      row: {
        name,
        state: "PATH_BLOCKED",
        detail: `Could not clear placeholder directory: ${reason}`,
      },
    };
  }
  return { kind: "cleared" };
}
