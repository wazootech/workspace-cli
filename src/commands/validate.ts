import { validateManifest } from "@/manifest.ts";
import type { WorkspaceManifest } from "@/types.ts";

export function run(manifest: WorkspaceManifest): number {
  validateManifest(manifest);
  console.log(
    `Manifest valid: ${manifest.repositories.length} repositories.`,
  );
  return 0;
}
