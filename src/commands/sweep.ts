import type { GitRunner } from "@/git.ts";
import type { ManifestPaths } from "@/manifest.ts";
import type { CliOptions } from "@/shared.ts";
import { printRows, scopeManifest } from "@/shared.ts";
import { runSweep } from "@/sweep.ts";
import { isSweepFailure } from "@/types.ts";
import type { WorkspaceManifest } from "@/types.ts";

export async function run(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  g: GitRunner,
): Promise<number> {
  const scoped = scopeManifest(opts, manifest);
  const rows = await runSweep(g, scoped, paths, {
    dryRun: opts.dryRun,
    deleteRemote: opts.deleteRemote,
    force: opts.force,
    // Scoped runs leave the root out: sweep only what was asked for.
    includeRoot: opts.workspace === undefined,
  });
  printRows(rows, opts.json);
  // Refusals are reported, not fatal (matching `update`); only a mutation that
  // actually broke is non-zero. `--strict` promotes refusals too.
  const failed = rows.some(isSweepFailure);
  // SKIPPED_REMOTE is a successful local cleanup with the remote ref kept by
  // design, so it is not a refusal.
  const refused = rows.some((row) =>
    row.kind.startsWith("SKIP_") && row.kind !== "SKIPPED_REMOTE"
  );
  return failed || (opts.strict && refused) ? 1 : 0;
}
