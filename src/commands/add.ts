import { SystemGit } from "@/git.ts";
import { resolveRepository } from "@/resolve.ts";
import { validateManifestText, validateSafeName } from "@/manifest.ts";
import { createGitHubRepo, probeGitHubRepo } from "@/remote.ts";
import type { CliOptions, EditRow } from "@/shared.ts";
import {
  applyEntryEdit,
  loadEditableManifest,
  manifestExtension,
  printRows,
} from "@/shared.ts";
import type { NewEntry } from "@/manifest-edit.ts";
import type { WorkspaceManifest } from "@/types.ts";

/**
 * Append a repository to the manifest's repositories array. Accepts a GitHub
 * shorthand (optionally creating a missing GitHub repository first) or an
 * explicit URL. Edits surgically and never touches local checkouts.
 */
export async function run(opts: CliOptions): Promise<number> {
  const loaded = await loadEditableManifest(opts);
  if (!loaded.ok) return loaded.code;
  return await runAdd(opts, loaded.manifest, loaded.manifestPath);
}

async function runAdd(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  manifestPath: string,
): Promise<number> {
  if (opts.positional.length > 1 && opts.name !== undefined) {
    console.error("Pass either a positional name or --name, not both");
    return 2;
  }
  const extra = opts.positional.slice(1);
  if (extra.length > 0) {
    console.error(`Unexpected arguments: ${extra.join(" ")}`);
    return 2;
  }

  const result = opts.url !== undefined
    ? resolveUrlEntry(opts)
    : await resolveShorthandEntry(opts, manifest);

  if (result === undefined) return 2;
  const { entry, entryName, rows } = result;

  const duplicate = manifest.repositories.find((r) => r.name === entryName);
  if (duplicate) {
    console.error(`Duplicate repository name: ${entryName}`);
    return 2;
  }

  const raw = await Deno.readTextFile(manifestPath);
  const newText = applyEntryEdit(
    raw,
    manifestExtension(manifestPath),
    "add",
    entry,
    entryName,
    manifest,
  );
  if (newText === undefined) return 2;

  try {
    validateManifestText(newText, manifestPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  rows.push({ name: entryName, action: "ADDED" });
  printRows(rows, opts.json);
  if (!opts.dryRun) {
    await Deno.writeTextFile(manifestPath, newText);
    console.log(`Next: run \`works install ${entryName}\` to clone it.`);
  }
  return 0;
}

interface ResolvedEntry {
  entry: NewEntry;
  entryName: string;
  rows: EditRow[];
}

function resolveUrlEntry(
  opts: CliOptions,
): ResolvedEntry | undefined {
  if (opts.create) {
    console.error(
      "--create applies to GitHub shorthand entries only; an explicit --url already names its remote",
    );
    return undefined;
  }

  const entryName = opts.name ?? opts.positional[0] ??
    deriveNameFromUrl(opts.url!);
  if (!tryValidateName(entryName)) return undefined;

  return {
    entry: { kind: "object", name: entryName, url: opts.url! },
    entryName,
    rows: [],
  };
}

async function resolveShorthandEntry(
  opts: CliOptions,
  manifest: WorkspaceManifest,
): Promise<ResolvedEntry | undefined> {
  const shorthand = opts.positional[0];
  if (!shorthand) {
    console.error("Usage: works add [<name>] [--url <url>] [--name <n>]");
    return undefined;
  }

  const host = manifest.host ?? "github.com";
  let expanded;
  try {
    expanded = resolveRepository({ host, owner: manifest.owner }, shorthand);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return undefined;
  }

  const rows: EditRow[] = [];
  if (host === "github.com") {
    const slug = new URL(expanded.url).pathname.replace(/^\//, "").replace(
      /\.git$/,
      "",
    );
    const ghOutcome = await ensureGitHubRepo(ghRunner(), slug, opts);
    if (typeof ghOutcome === "string") {
      console.error(ghOutcome);
      return undefined;
    }
    if (ghOutcome.status === "created") {
      rows.push({ name: expanded.name, action: "REMOTE_CREATED" });
    }
  }

  return {
    entry: { kind: "shorthand", raw: shorthand },
    entryName: expanded.name,
    rows,
  };
}

function tryValidateName(name: string): boolean {
  try {
    validateSafeName(name, "Repository name");
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

let cachedGh: SystemGit | undefined;

function ghRunner(): SystemGit {
  cachedGh ??= new SystemGit("gh");
  return cachedGh;
}

interface GitHubProbeResult {
  status: "found" | "created";
}

async function ensureGitHubRepo(
  gh: SystemGit,
  slug: string,
  opts: CliOptions,
): Promise<GitHubProbeResult | string> {
  let visibility: "public" | "private" | undefined;
  if (opts.visibility !== undefined) {
    if (!opts.create) {
      return "--visibility is only valid together with --create";
    }
    if (opts.visibility !== "public" && opts.visibility !== "private") {
      return `--visibility must be "public" or "private", got "${opts.visibility}"`;
    }
    visibility = opts.visibility;
  }

  let probe: Awaited<ReturnType<typeof probeGitHubRepo>>;
  try {
    probe = await probeGitHubRepo(gh, slug);
  } catch {
    return `gh CLI is not available; install it or add "${slug}" manually with --url`;
  }

  if (probe.status === "found") return { status: "found" };
  if (probe.status === "missing") {
    if (!opts.create) {
      return `not found: ${slug} does not exist on GitHub; rerun with --create to create it`;
    }
    try {
      const created = await createGitHubRepo(gh, slug, visibility ?? "private");
      if (!created.ok) {
        return `failed to create ${slug}: ${created.stderr ?? ""}`.trimEnd();
      }
      return { status: "created" };
    } catch {
      return `gh CLI is not available; cannot create ${slug}`;
    }
  }
  return `could not check ${slug}: ${probe.stderr ?? ""}`.trimEnd();
}

function deriveNameFromUrl(url: string): string {
  let path = url;
  if (path.includes("://")) path = path.slice(path.indexOf("://") + 3);
  const segments = path.split("/").filter((s) => s !== "");
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) {
    throw new Error(`Cannot derive a repository name from "${url}"`);
  }
  const derived = decodeURIComponent(lastSegment).replace(/\.git$/, "");
  if (!derived) {
    throw new Error(`Cannot derive a repository name from "${url}"`);
  }
  return derived;
}
