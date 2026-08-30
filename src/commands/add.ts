import { SystemGit } from "@/git.ts";
import { BARE_DEFAULT_HOST, resolveRepository } from "@/resolve.ts";
import { validateManifestText, validateSafeName } from "@/manifest.ts";
import { createGitHubRepo } from "@/remote.ts";
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

  const result = await resolveEntry(opts, manifest);

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
    console.log(`Next: run \`wspace install ${entryName}\` to clone it.`);
  }
  return 0;
}

interface ResolvedEntry {
  entry: NewEntry;
  entryName: string;
  rows: EditRow[];
}

async function resolveEntry(
  opts: CliOptions,
  manifest: WorkspaceManifest,
): Promise<ResolvedEntry | undefined> {
  if (opts.url !== undefined) {
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

  const shorthand = opts.positional[0];
  if (!shorthand) {
    console.error("Usage: wspace add [<name>] [--url <url>] [--name <n>]");
    return undefined;
  }

  if (opts.visibility !== undefined && !opts.create) {
    console.error("--visibility is only valid together with --create");
    return undefined;
  }

  const host = manifest.host ?? BARE_DEFAULT_HOST;
  let expanded;
  try {
    expanded = resolveRepository({ host, owner: manifest.owner }, shorthand);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return undefined;
  }

  if (!tryValidateName(expanded.name)) return undefined;

  const rows: EditRow[] = [];

  // --create: probe remote via git ls-remote, then create via gh if missing.
  if (opts.create) {
    if (!supportsGitHubProbe(host)) {
      console.error(
        `--create is only supported for GitHub-hosted repositories (host: ${host})`,
      );
      return undefined;
    }
    const git = new SystemGit();
    const exists = await probeRemote(git, expanded.url);
    if (!exists) {
      const slug = new URL(expanded.url).pathname.replace(/^\//, "").replace(
        /\.git$/,
        "",
      );
      const ghOutcome = await createGitHubRepoWithFallback(slug, opts);
      if (typeof ghOutcome === "string") {
        console.error(ghOutcome);
        return undefined;
      }
      if (ghOutcome.status === "created") {
        rows.push({ name: expanded.name, action: "REMOTE_CREATED" });
      }
    }
  }

  // Without --create: expand shorthand and add to manifest. No remote probe.
  // Remote validation is the user's responsibility or handled by `wspace install`.

  return {
    entry: { kind: "shorthand", raw: shorthand },
    entryName: expanded.name,
    rows,
  };
}

/** Check if a remote URL exists via git ls-remote. */
async function probeRemote(
  git: SystemGit,
  url: string,
): Promise<boolean> {
  const result = await git.run(["ls-remote", "--exit-code", url]);
  return result.code === 0;
}

/**
 * Whether the given host supports GitHub creation via the `gh` CLI.
 * Extensible for GitHub Enterprise instances in the future.
 */
function supportsGitHubProbe(host: string): boolean {
  return host === BARE_DEFAULT_HOST;
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

async function createGitHubRepoWithFallback(
  slug: string,
  opts: CliOptions,
): Promise<GitHubProbeResult | string> {
  let visibility: "public" | "private" | undefined;
  if (opts.visibility !== undefined) {
    if (opts.visibility !== "public" && opts.visibility !== "private") {
      return `--visibility must be "public" or "private", got "${opts.visibility}"`;
    }
    visibility = opts.visibility;
  }

  try {
    const created = await createGitHubRepo(
      ghRunner(),
      slug,
      visibility ?? "private",
    );
    if (!created.ok) {
      return `failed to create ${slug}: ${created.stderr ?? ""}`.trimEnd();
    }
    return { status: "created" };
  } catch {
    return `gh CLI is not available; cannot create ${slug}. Install gh or add manually with --url`;
  }
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
