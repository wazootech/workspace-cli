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
