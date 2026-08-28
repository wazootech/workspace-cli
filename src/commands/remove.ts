import { exists } from "@std/fs";
import {
  manifestPaths,
  resolveRepositoryPath,
  validateManifestText,
} from "@/manifest.ts";
import type { CliOptions } from "@/shared.ts";
import {
  applyEntryEdit,
  loadEditableManifest,
  manifestExtension,
  printRows,
} from "@/shared.ts";
import type { WorkspaceManifest } from "@/types.ts";

/**
 * Remove a repository from the manifest's repositories array. Edits
 * surgically; any local checkout is left on disk and its location is noted.
 */
export async function run(opts: CliOptions): Promise<number> {
  const loaded = await loadEditableManifest(opts);
  if (!loaded.ok) return loaded.code;
  return await runRemove(opts, loaded.manifest, loaded.manifestPath);
}

async function runRemove(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  manifestPath: string,
): Promise<number> {
  if (
    opts.url !== undefined || opts.name !== undefined ||
    opts.visibility !== undefined || opts.create
  ) {
    console.error("remove takes only a repository name");
    return 2;
  }
  const target = opts.positional[0];
  if (!target || opts.positional.length > 1) {
    console.error("Usage: works remove <repo>");
    return 2;
  }
  const existing = manifest.repositories.find((r) => r.name === target);
  if (!existing) {
    console.error(`Repository "${target}" not found in manifest`);
    return 2;
  }

  const raw = await Deno.readTextFile(manifestPath);
  const newText = applyEntryEdit(
    raw,
    manifestExtension(manifestPath),
    "remove",
    undefined,
    target,
    manifest,
  );
  if (newText === undefined) return 2;

  try {
    validateManifestText(newText, manifestPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const paths = manifestPaths(manifest, manifestPath);
  const repoPath = resolveRepositoryPath(existing, paths);
  const checkoutRemains = await exists(repoPath);

  if (!opts.dryRun) {
    await Deno.writeTextFile(manifestPath, newText);
  }
  printRows([{ name: target, action: "REMOVED" }], opts.json);
  if (checkoutRemains) {
    console.error(
      `NOTE: local checkout remains on disk at ${repoPath}; remove it manually if desired`,
    );
  }
  return 0;
}
