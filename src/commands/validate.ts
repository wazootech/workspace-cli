import { validateManifest } from "@/manifest.ts";
import type { WorkspaceManifest } from "@/types.ts";

export function run(manifest: WorkspaceManifest): number {
  validateManifest(manifest);
  const repositoryCount = manifest.repositories.length;
  const workspaceCount = manifest.workspaces?.length ?? 0;
  console.log(
    `Manifest valid: ${repositoryCount} repositories, ${workspaceCount} workspaces.`,
  );
  return 0;
}
