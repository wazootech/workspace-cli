import { dirname, join, resolve } from "@std/path";
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_MANIFEST_FILENAMES,
  findExistingManifest,
  MANIFEST_EXTENSIONS,
  normalizeManifest,
  type RawManifest,
  validateManifest,
} from "@/manifest.ts";
import type { CliOptions } from "@/shared.ts";

/**
 * Scaffold a brand-new workspace: write a fresh manifest (schema v4) with
 * optional host/owner and seeded shorthand entries, create the standard
 * directories, and point the user at `works install`. Fails closed when any
 * manifest already exists in the target directory; seeds are validated through
 * the same normalize/validate pipeline as an existing manifest before
 * anything is written.
 */
export async function run(opts: CliOptions): Promise<number> {
  const cwd = Deno.cwd();
  const target = opts.manifestPath
    ? resolve(cwd, opts.manifestPath)
    : resolve(cwd, DEFAULT_MANIFEST_FILENAMES[0] + MANIFEST_EXTENSIONS[0]);
  const targetDir = dirname(target);

  const existing = await findExistingManifest(targetDir);
  if (existing) {
    console.error(`Refusing to overwrite existing manifest: ${existing}`);
    return 2;
  }

  const doc: RawManifest = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    repositories: opts.positional,
  };
  if (opts.host !== undefined) {
    doc.host = opts.host;
  }
  if (opts.owner !== undefined) {
    doc.owner = opts.owner;
  }

  try {
    const normalized = normalizeManifest(doc, target);
    validateManifest(normalized);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error),
    );
    return 2;
  }

  await Deno.mkdir(join(targetDir, "repos"), { recursive: true });
  await Deno.mkdir(join(targetDir, "worktrees"), { recursive: true });
  await Deno.mkdir(join(targetDir, "secrets"), { recursive: true });
  await Deno.writeTextFile(target, JSON.stringify(doc, null, 2) + "\n");

  console.log(`Created ${target} (schema v${CURRENT_SCHEMA_VERSION})`);
  console.log("Created repos/, worktrees/, secrets/");
  if (opts.positional.length > 0) {
    console.log("Next: run `works install` to clone the listed repositories.");
  }
  return 0;
}
