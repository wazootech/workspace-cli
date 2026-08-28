import { resolve } from "@std/path";
import { exists } from "@std/fs";
import { findDefaultManifestPath, loadManifest } from "./manifest.ts";
import {
  addEntryJsonc,
  formatEntryJsonc,
  ManifestEditError,
  removeEntryJsonc,
} from "./manifest-edit.ts";
import type { NewEntry } from "./manifest-edit.ts";
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
 * Scope a manifest to a single sub-workspace by name for commands that
 * support `--workspace` (check, update, worktree). Unscoped when unset.
 */
export function scopeManifest(
  opts: Pick<CliOptions, "workspace">,
  manifest: WorkspaceManifest,
): WorkspaceManifest {
  const repos = opts.workspace
    ? manifest.repositories.filter((r) => r.workspace === opts.workspace)
    : manifest.repositories;
  return { ...manifest, repositories: repos };
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

export interface EditRow {
  name: string;
  action: "ADDED" | "REMOVED" | "REMOTE_CREATED";
  detail?: string;
}

export function manifestExtension(manifestPath: string): string {
  return manifestPath.slice(manifestPath.lastIndexOf(".")).toLowerCase();
}

export function isJsonLike(extension: string): boolean {
  return extension === ".json" || extension === ".jsonc";
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
    if (isJsonLike(extension)) {
      return mode === "add"
        ? addEntryJsonc(raw, formatEntryJsonc(entry!))
        : removeEntryJsonc(raw, targetName, owner, host);
    }
    throw new ManifestEditError(
      `Unsupported manifest format "${extension}" for editing`,
    );
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
      `No manifest found at ${manifestPath}; run \`works init\` first`,
    );
    return { ok: false, code: 2 };
  }
  const extension = manifestExtension(manifestPath);
  if (!isJsonLike(extension)) {
    console.error(
      `Unsupported manifest format "${extension}" for editing (supported: .json, .jsonc)`,
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
