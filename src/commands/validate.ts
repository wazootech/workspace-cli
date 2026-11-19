import { validateManifest } from "@/manifest.ts";
import type { WorkspaceManifest } from "@/types.ts";

/** Throws when the manifest itself is invalid; prints nothing. */
export function check(manifest: WorkspaceManifest): void {
  validateManifest(manifest);
}

/** Print the success summary for a manifest that already passed every gate. */
export function report(manifest: WorkspaceManifest): number {
  const repositoryCount = manifest.repositories.length;
  const workspaceCount = manifest.workspaces?.length ?? 0;
  console.log(
    `Manifest valid: ${repositoryCount} repositories, ${workspaceCount} workspaces.`,
  );
  return 0;
}

export function run(manifest: WorkspaceManifest): number {
  check(manifest);
  return report(manifest);
}
