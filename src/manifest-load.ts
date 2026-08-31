import { resolve } from "@std/path";
import { exists } from "@std/fs";
import { findDefaultManifestPath } from "./manifest-discovery.ts";
import { loadManifest } from "./manifest-normalize.ts";
import {
  addEntry,
  formatEntry,
  ManifestEditError,
  removeEntry,
} from "./manifest-edit.ts";
import type { NewEntry } from "./manifest-edit.ts";
import type { WorkspaceManifest } from "./types.ts";
import type { CliOptions } from "./cli-options.ts";

export async function resolveManifestPath(
  opts: Pick<CliOptions, "manifestPath">,
): Promise<string> {
  return opts.manifestPath
    ? resolve(Deno.cwd(), opts.manifestPath)
    : await findDefaultManifestPath();
}

export interface EditRow {
  name: string;
  action: "ADDED" | "REMOVED" | "REMOTE_CREATED";
  detail?: string;
}

export function manifestExtension(manifestPath: string): string {
  return manifestPath.slice(manifestPath.lastIndexOf(".")).toLowerCase();
}

/**
 * Apply a surgical add/remove edit to the repositories array of a manifest,
 * returning the rewritten text or undefined when the edit is rejected.
 */
export function applyEntryEdit(
  raw: string,
  extension: string,
  mode: "add" | "remove",
  entry: NewEntry | undefined,
  targetName: string,
  manifest: WorkspaceManifest,
): string | undefined {
  const owner = manifest.owner;
  const host = manifest.host ?? "github.com";
  try {
    if (extension !== ".json") {
      throw new ManifestEditError(
        `Unsupported manifest format "${extension}" for editing`,
      );
    }
    return mode === "add"
      ? addEntry(raw, formatEntry(entry!))
      : removeEntry(raw, targetName, owner, host);
  } catch (error) {
    if (error instanceof ManifestEditError) {
      console.error(error.message);
      return undefined;
    }
    throw error;
  }
}

export type EditableManifest =
  | { ok: true; manifest: WorkspaceManifest; manifestPath: string }
  | { ok: false; code: number };

/**
 * Load a manifest for surgical editing (add/remove). These commands edit the
 * manifest file itself and produce their own friendly errors when it is
 * missing or malformed, so this path skips the shared load used by every
 * other command.
 */
export async function loadEditableManifest(
  opts: CliOptions,
): Promise<EditableManifest> {
  const manifestPath = await resolveManifestPath(opts);
  if (!(await exists(manifestPath))) {
    console.error(
      `No manifest found at ${manifestPath}; run \`wspace init\` first`,
    );
    return { ok: false, code: 2 };
  }
  const extension = manifestExtension(manifestPath);
  if (extension !== ".json") {
    console.error(
      `Unsupported manifest format "${extension}" for editing (supported: .json)`,
    );
    return { ok: false, code: 2 };
  }
  try {
    const manifest = await loadManifest(manifestPath);
    return { ok: true, manifest, manifestPath };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return { ok: false, code: 2 };
  }
}
