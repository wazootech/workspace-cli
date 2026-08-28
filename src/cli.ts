import { parseArgs } from "@std/cli/parse-args";
import { exists } from "@std/fs";
import { SystemGit } from "./git.ts";
import {
  detectConflicts,
  expandShorthand,
  loadManifest,
  manifestPaths,
  resolveRepositoryPath,
  resolveWorkspaceTree,
  validateManifestText,
  validateSafeName,
} from "./manifest.ts";
import {
  addEntryJsonc,
  formatEntryJsonc,
  ManifestEditError,
  removeEntryJsonc,
} from "./manifest-edit.ts";
import type { NewEntry } from "./manifest-edit.ts";
import { createGitHubRepo, probeGitHubRepo } from "./remote.ts";
import { flattenResolved, printRows, resolveManifestPath } from "./shared.ts";
import type { CliOptions } from "./shared.ts";
import type { WorkspaceManifest } from "./types.ts";

import * as checkCmd from "./commands/check.ts";
import * as envCmd from "./commands/env.ts";
import * as initCmd from "./commands/init.ts";
import * as installCmd from "./commands/install.ts";
import * as updateCmd from "./commands/update.ts";
import * as validateCmd from "./commands/validate.ts";
import * as worktreeCmd from "./commands/worktree.ts";
import * as workspacesCmd from "./commands/workspaces.ts";

const COMMANDS = [
  "check",
  "init",
  "install",
  "add",
  "remove",
  "update",
  "worktree",
  "workspaces",
  "env",
  "validate",
];

const COMMAND_ALIASES: Record<string, string> = {
  "i": "install",
};

class CliHelp extends Error {}

function usage(): void {
  console.log(`workspace-cli (works)

Usage:
  works check [--json] [--workspace <name>]
  works init [--host <host>] [--owner <owner>] [<repo...>]
  works install [<repo...>] [--json] [--workspace <name>]
  works i [<repo...>] [--json] [--workspace <name>]      (alias for install)
  works add [<name>] [--url <url>] [--name <n>] [--create] [--visibility <public|private>]
  works remove <repo>
  works update [--json] [--workspace <name>]
  works worktree add <repo> <feature> [<commit-ish>]
  works worktree list [--stale] [--json] [--workspace <name>]
  works worktree remove <repo> <feature>
  works workspaces [--json]
  works env sync [--dry-run] [--json]
  works validate

Options:
  --manifest <path>   Manifest path (default: workspace.json / workspace.jsonc)
  --host <host>       init: hostname for shorthand expansion (default: github.com)
  --owner <owner>     init: owner for shorthand entries
  --url <url>         add: explicit clone URL (writes an object entry)
  --name <n>          add: local name when using --url (defaults to URL basename)
  --create            add: create a missing GitHub repository before adding
  --visibility <v>    add: visibility used with --create (private|public; default private)
  --json              Machine-readable output
  --stale             Filter worktrees fully merged into origin/<default> (or missing branch)
  --dry-run           Preview environment sync operations without modifying files
  --workspace <name>  Scope command to a specific sub-workspace (by name)

Worktree Commands:
  worktree add       Creates a worktree at worktrees/<repo>/<feature> on branch <feature>.
                     Start-point defaults to origin/<default> (resolved via origin/HEAD).
  worktree list      Lists active worktrees. With --stale, lists safe removal candidates.
  worktree remove    Removes a worktree at worktrees/<repo>/<feature> and prunes stale references.

Sub-workspaces:
  workspaces         Lists discovered sub-workspaces with repo counts.`);
}

function parseCliArgs(args: string[]): CliOptions {
  const parsed = parseArgs(args, {
    boolean: ["help", "json", "stale", "dry-run", "create"],
    string: [
      "manifest",
      "workspace",
      "host",
      "owner",
      "url",
      "name",
      "visibility",
    ],
    alias: { h: "help" },
  });
  if (parsed.help) {
    usage();
    throw new CliHelp();
  }
  const positional = parsed._.map(String);
  const command = COMMAND_ALIASES[positional[0]] ?? positional[0];
  if (!command || !COMMANDS.includes(command)) {
    console.error(`Unknown or missing command: ${positional[0] ?? "(none)"}\n`);
    usage();
    throw new Error(`Unknown or missing command: ${positional[0] ?? "(none)"}`);
  }
  return {
    command,
    subcommand: positional[1],
    manifestPath: parsed.manifest,
    host: parsed.host,
    owner: parsed.owner,
    url: parsed.url,
    name: parsed.name,
    visibility: parsed.visibility,
    create: parsed.create ?? false,
    json: parsed.json ?? false,
    stale: parsed.stale ?? false,
    dryRun: parsed["dry-run"] ?? false,
    // worktree/env consume a subcommand; every other command treats all
    // trailing words as its own arguments.
    positional: command === "worktree" || command === "env"
      ? positional.slice(2)
      : positional.slice(1),
    workspace: parsed.workspace,
  };
}

interface EditRow {
  name: string;
  action: "ADDED" | "REMOVED" | "REMOTE_CREATED";
  detail?: string;
}

function manifestExtension(manifestPath: string): string {
  return manifestPath.slice(manifestPath.lastIndexOf(".")).toLowerCase();
}

function isJsonLike(extension: string): boolean {
  return extension === ".json" || extension === ".jsonc";
}

/**
 * Curate the repositories array of an existing manifest: `add` appends a
 * shorthand or explicit-url entry (optionally creating a missing GitHub
 * repository first), `remove` deletes an entry by effective name. Both edit
 * surgically, re-validate the rewritten document before writing, and never
 * touch local checkouts.
 */
async function runManifestEdit(
  opts: CliOptions,
  manifestPath: string,
): Promise<number> {
  if (!(await exists(manifestPath))) {
    console.error(
      `No manifest found at ${manifestPath}; run \`works init\` first`,
    );
    return 2;
  }
  const extension = manifestExtension(manifestPath);
  if (!isJsonLike(extension)) {
    console.error(
      `Unsupported manifest format "${extension}" for editing (supported: .json, .jsonc)`,
    );
    return 2;
  }
  let manifest: WorkspaceManifest;
  try {
    manifest = await loadManifest(manifestPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  return opts.command === "add"
    ? await runAdd(opts, manifest, manifestPath)
    : await runRemove(opts, manifest, manifestPath);
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

  let entry: NewEntry;
  let entryName: string;
  const rows: EditRow[] = [];

  if (opts.url !== undefined) {
    if (opts.create) {
      console.error(
        "--create applies to GitHub shorthand entries only; an explicit --url already names its remote",
      );
      return 2;
    }
    const explicit = opts.name ?? opts.positional[0];
    if (explicit !== undefined) {
      entryName = explicit;
    } else {
      try {
        entryName = deriveNameFromUrl(opts.url);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 2;
      }
    }
    try {
      validateSafeName(entryName, "Repository name");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
    entry = { kind: "object", name: entryName, url: opts.url };
  } else {
    const shorthand = opts.positional[0];
    if (!shorthand) {
      console.error("Usage: works add [<name>] [--url <url>] [--name <n>]");
      return 2;
    }
    const host = manifest.host ?? "github.com";
    let expanded;
    try {
      expanded = expandShorthand("manifest", shorthand, manifest.owner, host);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
    entryName = expanded.name;

    if (host === "github.com") {
      const slug = expanded.url
        .replace(/^https:\/\/github\.com\//, "")
        .replace(/\.git$/, "");
      const ghOutcome = await ensureGitHubRepo(ghRunner(), slug, opts);
      if (typeof ghOutcome === "string") {
        console.error(ghOutcome);
        return 1;
      }
      if (ghOutcome === "created") {
        rows.push({ name: entryName, action: "REMOTE_CREATED" });
      }
    }
    entry = { kind: "shorthand", raw: shorthand };
  }

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

function applyEntryEdit(
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

let cachedGh: SystemGit | undefined;

function ghRunner(): SystemGit {
  cachedGh ??= new SystemGit("gh");
  return cachedGh;
}

/**
 * Probe (and optionally create) the GitHub repository for a shorthand entry.
 * Returns "found", "created", or an error message string.
 */
async function ensureGitHubRepo(
  gh: SystemGit,
  slug: string,
  opts: CliOptions,
): Promise<"found" | "created" | string> {
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
  if (probe.status === "found") return "found";
  if (probe.status === "missing") {
    if (!opts.create) {
      return `not found: ${slug} does not exist on GitHub; rerun with --create to create it`;
    }
    try {
      const created = await createGitHubRepo(gh, slug, visibility ?? "private");
      if (!created.ok) {
        return `failed to create ${slug}: ${created.stderr ?? ""}`.trimEnd();
      }
      return "created";
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

export async function run(args: string[]): Promise<number> {
  const opts = parseCliArgs(args);

  // init scaffolds a brand-new workspace; it must not require an existing
  // manifest, so it short-circuits before manifest loading.
  if (opts.command === "init") {
    return await initCmd.run(opts);
  }

  // add/remove edit the manifest file itself and produce their own friendly
  // errors when it is missing or malformed, so they also skip the shared
  // load below.
  if (opts.command === "add" || opts.command === "remove") {
    return await runManifestEdit(opts, await resolveManifestPath(opts));
  }

  const manifestPath = await resolveManifestPath(opts);
  const manifest = await loadManifest(manifestPath);
  const g = new SystemGit();

  if (opts.command === "install") {
    return await installCmd.run(opts, manifest, manifestPath, g);
  }

  // Every other command resolves once; detected sub-workspaces reflect
  // whatever is currently on disk.
  const resolvedTree = resolveWorkspaceTree(manifest, manifestPath);

  // Detect conflicts.
  const conflicts = detectConflicts(resolvedTree);
  if (conflicts.length > 0) {
    console.error("ERROR: Duplicate repository names across workspaces:");
    for (const c of conflicts) {
      console.error(
        `  "${c.repoName}" claimed by: ${c.claimedBy.join(", ")}`,
      );
    }
    return 2;
  }

  // Handle the workspaces command with resolved data.
  if (opts.command === "workspaces") {
    return await workspacesCmd.run(opts, resolvedTree);
  }

  if (opts.command === "validate") {
    return await validateCmd.run(manifest);
  }

  const resolvedManifest = flattenResolved(resolvedTree, manifest);
  const paths = manifestPaths(manifest, manifestPath);

  switch (opts.command) {
    case "check":
      return await checkCmd.run(opts, resolvedManifest, paths, g);
    case "update":
      return await updateCmd.run(opts, resolvedManifest, paths, g);
    case "worktree":
      return await worktreeCmd.run(opts, resolvedManifest, paths, g);
    case "env":
      return await envCmd.run(opts, resolvedManifest, paths, g);
    default:
      return 2;
  }
}

export async function main(): Promise<number> {
  try {
    return await run(Deno.args);
  } catch (error) {
    if (error instanceof CliHelp) {
      return 0;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (import.meta.main) {
  main().then((code) => Deno.exit(code));
}
