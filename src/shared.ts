import { resolve } from "@std/path";
import { findDefaultManifestPath } from "./manifest.ts";
import type { ResolvedWorkspace, WorkspaceManifest } from "./types.ts";

/** Options parsed from the CLI invocation, shared by every command module. */
export interface CliOptions {
  command: string;
  subcommand?: string;
  manifestPath?: string;
  host?: string;
  owner?: string;
  url?: string;
  name?: string;
  visibility?: string;
  create: boolean;
  json: boolean;
  stale: boolean;
  dryRun: boolean;
  positional: string[];
  workspace?: string;
}

export function printRows(rows: unknown[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.table(rows);
  }
}

/**
 * Scope a manifest to a single sub-workspace by name for commands that
 * support `--workspace` (check, update, worktree). Unscoped when unset.
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

export async function resolveManifestPath(
  opts: Pick<CliOptions, "manifestPath">,
): Promise<string> {
  return opts.manifestPath
    ? resolve(Deno.cwd(), opts.manifestPath)
    : await findDefaultManifestPath();
}
