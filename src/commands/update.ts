import type { GitRunner } from "@/git.ts";
import type { ManifestPaths } from "@/manifest.ts";
import type { CliOptions } from "@/shared.ts";
import { printRows, scopeManifest } from "@/shared.ts";
import type { WorkspaceManifest } from "@/types.ts";
import { runUpdate } from "@/update.ts";

export async function run(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  g: GitRunner,
): Promise<number> {
  const scoped = scopeManifest(opts, manifest);
  const rows = await runUpdate(g, scoped, paths);
  printRows(rows, opts.json);
  return 0;
}
