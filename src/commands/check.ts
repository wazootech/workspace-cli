import type { GitRunner } from "../git.ts";
import type { ManifestPaths } from "../manifest.ts";
import type { CliOptions } from "../shared.ts";
import { printRows, scopeManifest } from "../shared.ts";
import { collectStatus, hasErrors } from "../status.ts";
import type { WorkspaceManifest } from "../types.ts";

export async function run(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  g: GitRunner,
): Promise<number> {
  const scoped = scopeManifest(opts, manifest);
  const rows = await collectStatus(g, scoped, paths);
  printRows(rows, opts.json);
  return hasErrors(rows) ? 1 : 0;
}
