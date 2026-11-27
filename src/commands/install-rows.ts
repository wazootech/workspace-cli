import { findExistingManifest } from "@/manifest-discovery.ts";

export type InstallRow = { name: string; state: string; detail?: string };

export function isBadInstallRow(row: InstallRow): boolean {
  return (
    row.state === "CLONE_FAILED" ||
    row.state === "PATH_BLOCKED" ||
    row.state === "INVALID" ||
    row.state === "UNKNOWN_REPO"
  );
}

export async function workspaceManifestMissing(
  repository: { name: string; isWorkspace?: boolean; error?: string },
  repoPath: string,
): Promise<InstallRow | undefined> {
  if (!repository.isWorkspace) return undefined;
  // Resolution already flagged this checkout (exists but not git, or lacks a
  // child manifest); surface its error verbatim.
  if (repository.error) {
    return {
      name: repository.name,
      state: "INVALID",
      detail: repository.error,
    };
  }
  // Fresh clone that turned out manifest-less.
  if (!(await findExistingManifest(repoPath))) {
    return {
      name: repository.name,
      state: "INVALID",
      detail: `Workspace repository does not contain workspace.json at ${repoPath}`,
    };
  }
  return undefined;
}
