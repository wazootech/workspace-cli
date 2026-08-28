import { syncEnv } from "../env.ts";
import type { GitRunner } from "../git.ts";
import type { ManifestPaths } from "../manifest.ts";
import type { CliOptions } from "../shared.ts";
import { printRows } from "../shared.ts";
import type { WorkspaceManifest } from "../types.ts";

export async function run(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  g: GitRunner,
): Promise<number> {
  if (opts.subcommand !== "sync") {
    console.error("Usage: works env sync [--dry-run] [--json]");
    return 2;
  }
  const rows = await syncEnv(g, manifest, paths, { dryRun: opts.dryRun });
  printRows(rows, opts.json);
  const hasFailed = rows.some((r) => r.action === "FAILED");
  return hasFailed ? 1 : 0;
}
