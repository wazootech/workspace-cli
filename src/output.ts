import type { ResolvedWorkspace, WorkspaceManifest } from "./types.ts";
import type { CliOptions } from "./cli-options.ts";

export function printRows(rows: unknown[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.table(rows);
  }
}

/**
 * Scope a manifest to a single sub-workspace by name for commands that
 * support `--workspace` (check, update). Unscoped when unset.
 */
export function scopeManifest(
  opts: Pick<CliOptions, "workspace">,
  manifest: WorkspaceManifest,
): WorkspaceManifest {
  const repos = opts.workspace
    ? manifest.repositories.filter((r) => r.workspace === opts.workspace)
    : manifest.repositories;
  return { ...manifest, repositories: repos };
}

/**
 * Flatten a resolved tree into the manifest shape commands consume.
 */
export function flattenResolved(
  resolved: ResolvedWorkspace,
  root: WorkspaceManifest,
): WorkspaceManifest {
  return { ...root, repositories: resolved.repositories };
}
