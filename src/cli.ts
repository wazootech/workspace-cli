import { dirname, join, resolve } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import { syncEnv } from "./env.ts";
import { clone, defaultBranch } from "./git.ts";
import type { GitRunner } from "./git.ts";
import { SystemGit } from "./git.ts";
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_MANIFEST_FILENAMES,
  detectConflicts,
  expandShorthand,
  findDefaultManifestPath,
  findExistingManifest,
  listWorkspaces,
  loadManifest,
  MANIFEST_EXTENSIONS,
  manifestPaths,
  normalizeManifest,
  resolveRepositoryPath,
  resolveWorkspaceTree,
  validateManifest,
  validateManifestText,
  validateSafeName,
} from "./manifest.ts";
import type { ManifestPaths } from "./manifest.ts";
import {
  addEntryJsonc,
  formatEntryJsonc,
  ManifestEditError,
  removeEntryJsonc,
} from "./manifest-edit.ts";
import type { NewEntry } from "./manifest-edit.ts";
import { createGitHubRepo, probeGitHubRepo } from "./remote.ts";
import { exists } from "@std/fs";
import { collectStatus, hasErrors } from "./status.ts";
import type { ResolvedWorkspace, WorkspaceManifest } from "./types.ts";

import { runUpdate } from "./update.ts";
import {
  addWorktree,
  branchExists,
  defaultBranchStartPoint,
  listWorktrees,
  removeWorktree,
  staleness,
} from "./worktrees.ts";

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

class CliHelp extends Error {}

interface CliOptions {
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

function usage(): void {
  console.log(`workspace-cli (works)

Usage:
  works check [--json] [--workspace <name>]
  works init [--host <host>] [--owner <owner>] [<repo...>]
  works install [<repo...>] [--json] [--workspace <name>]
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
  --manifest <path>   Manifest path (default: workspace.json / wspace.json / repos.json)
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
  const command = positional[0];
  if (!command || !COMMANDS.includes(command)) {
    console.error(`Unknown or missing command: ${command ?? "(none)"}\n`);
    usage();
    throw new Error(`Unknown or missing command: ${command ?? "(none)"}`);
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

async function runWorktree(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  g: GitRunner,
): Promise<number> {
  switch (opts.subcommand) {
    case "list": {
      const rows: {
        repo: string;
        path: string;
        branch?: string;
        bare: boolean;
        detached: boolean;
        stale?: boolean;
        reason?: string;
      }[] = [];
      for (const repository of manifest.repositories) {
        const repoPath = resolveRepositoryPath(repository, paths);
        if (!(await exists(repoPath))) {
          continue;
        }
        const defaultName = opts.stale
          ? await defaultBranch(g, repoPath)
          : undefined;
        for (const wt of await listWorktrees(g, repoPath)) {
          const row: (typeof rows)[number] = {
            repo: repository.name,
            path: wt.path,
            branch: wt.branch,
            bare: wt.bare,
            detached: wt.detached,
          };
          if (opts.stale) {
            const s = await staleness(g, repoPath, wt, defaultName);
            row.stale = s.stale;
            if (s.reason) {
              row.reason = s.reason;
            }
          }
          rows.push(row);
        }
      }
      const filtered = opts.stale ? rows.filter((r) => r.stale) : rows;
      if (opts.json) {
        console.log(JSON.stringify(filtered, null, 2));
      } else {
        console.table(filtered);
      }
      return 0;
    }
    case "add": {
      const [repoName, feature, startPoint] = opts.positional;
      if (!repoName || !feature) {
        console.error(
          "Usage: works worktree add <repo> <feature> [<commit-ish>]",
        );
        return 2;
      }
      const repository = manifest.repositories.find((r) => r.name === repoName);
      if (!repository) {
        console.error(`Unknown repository: ${repoName}`);
        return 2;
      }
      const repoPath = resolveRepositoryPath(repository, paths);
      if (!(await exists(repoPath))) {
        console.error(`Repository not cloned: ${repoName}`);
        return 2;
      }
      const worktreePath = join(paths.worktreesDirectory, repoName, feature);
      if (await exists(worktreePath)) {
        console.error(`Worktree path already exists: ${worktreePath}`);
        return 2;
      }
      const reattach = await branchExists(g, repoPath, feature);
      let startPointArg: string | undefined = startPoint;
      if (reattach) {
        console.warn(
          `Branch ${feature} already exists; attaching existing branch`,
        );
      } else {
        startPointArg ??= await defaultBranchStartPoint(g, repoPath);
        if (!startPointArg) {
          console.error(
            "Cannot resolve a default-branch baseline (no origin/HEAD); pass an explicit <commit-ish>",
          );
          return 2;
        }
      }
      const result = await addWorktree(
        g,
        repoPath,
        worktreePath,
        feature,
        startPointArg,
      );
      if (result.code !== 0) {
        console.error(result.stderr);
        return 1;
      }
      console.log(`Created worktree ${worktreePath} on branch ${feature}`);
      return 0;
    }
    case "remove": {
      const [repoName, feature] = opts.positional;
      if (!repoName || !feature) {
        console.error("Usage: works worktree remove <repo> <feature>");
        return 2;
      }
      const repository = manifest.repositories.find((r) => r.name === repoName);
      if (!repository) {
        console.error(`Unknown repository: ${repoName}`);
        return 2;
      }
      const repoPath = resolveRepositoryPath(repository, paths);
      if (!(await exists(repoPath))) {
        console.error(`Repository not cloned: ${repoName}`);
        return 2;
      }
      const worktreePath = join(paths.worktreesDirectory, repoName, feature);
      const result = await removeWorktree(g, repoPath, worktreePath);
      if (result.code !== 0) {
        console.error(result.stderr);
        return 1;
      }
      await Deno.remove(join(paths.worktreesDirectory, repoName), {
        recursive: false,
      }).catch(() => {});
      console.log(`Removed worktree ${worktreePath}`);
      return 0;
    }
    default:
      console.error("Usage: works worktree add|list|remove");
      return 2;
  }
}

async function cloneMissing(
  g: GitRunner,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  targets: string[] = [],
): Promise<{ name: string; state: string; detail?: string }[]> {
  await Deno.mkdir(paths.repositoriesDirectory, { recursive: true });
  let repositories = manifest.repositories;
  if (targets.length > 0) {
    const validNames = new Set(manifest.repositories.map((r) => r.name));
    for (const name of targets) {
      if (!validNames.has(name)) {
        return [{
          name,
          state: "UNKNOWN_REPO",
          detail: `Repository "${name}" not found in manifest`,
        }];
      }
    }
    const targetSet = new Set(targets);
    repositories = repositories.filter((r) => targetSet.has(r.name));
  }
  const rows: { name: string; state: string; detail?: string }[] = [];
  for (const repository of repositories) {
    const repoPath = resolveRepositoryPath(repository, paths);
    if (await exists(repoPath)) {
      if (await exists(join(repoPath, ".git"))) {
        rows.push({ name: repository.name, state: "EXISTS" });
      } else {
        rows.push({
          name: repository.name,
          state: "PATH_BLOCKED",
          detail: "Path exists but is not a Git repository",
        });
      }
      continue;
    }
    if (!repository.url) {
      throw new Error(
        `Repository "${repository.name}" is missing its clone url`,
      );
    }
    const result = await clone(g, repository.url, repoPath);
    rows.push(
      result.code === 0 ? { name: repository.name, state: "CLONED" } : {
        name: repository.name,
        state: "CLONE_FAILED",
        detail: result.stderr.trim() || `Exit code ${result.code}`,
      },
    );
  }
  return rows;
}

async function runCommand(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  g: GitRunner,
): Promise<number> {
  switch (opts.command) {
    case "check": {
      const repos = opts.workspace
        ? manifest.repositories.filter((r) => r.workspace === opts.workspace)
        : manifest.repositories;
      const scopedManifest = { ...manifest, repositories: repos };
      const rows = await collectStatus(g, scopedManifest, paths);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        console.table(rows);
      }
      return hasErrors(rows) ? 1 : 0;
    }
    case "install": {
      // Install runs through the converging fixpoint in runInstall
      // before runCommand is reached; this case only handles misuse.
      console.error(
        "Usage: works install [<repo...>] [--json] [--workspace <name>]",
      );
      return 2;
    }
    case "update": {
      const repos = opts.workspace
        ? manifest.repositories.filter((r) => r.workspace === opts.workspace)
        : manifest.repositories;
      const scopedManifest = { ...manifest, repositories: repos };
      const rows = await runUpdate(g, scopedManifest, paths);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        console.table(rows);
      }
      return 0;
    }
    case "worktree": {
      const repos = opts.workspace
        ? manifest.repositories.filter((r) => r.workspace === opts.workspace)
        : manifest.repositories;
      const scopedManifest = { ...manifest, repositories: repos };
      return await runWorktree(opts, scopedManifest, paths, g);
    }
    case "env": {
      if (opts.subcommand !== "sync") {
        console.error("Usage: works env sync [--dry-run] [--json]");
        return 2;
      }
      const rows = await syncEnv(g, manifest, paths, { dryRun: opts.dryRun });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        console.table(rows);
      }
      const hasFailed = rows.some((r) => r.action === "FAILED");
      return hasFailed ? 1 : 0;
    }
    case "validate": {
      validateManifest(manifest);
      console.log(
        `Manifest valid: ${manifest.repositories.length} repositories.`,
      );
      return 0;
    }
    default:
      return 2;
  }
}

type InstallRow = { name: string; state: string; detail?: string };

function isBadInstallRow(row: InstallRow): boolean {
  return (
    row.state === "CLONE_FAILED" ||
    row.state === "PATH_BLOCKED" ||
    row.state === "INVALID" ||
    row.state === "UNKNOWN_REPO"
  );
}

function printRows(rows: unknown[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.table(rows);
  }
}

/**
 * Flatten a resolved tree into the manifest shape commands consume.
 */
function flattenResolved(
  resolved: ResolvedWorkspace,
  root: WorkspaceManifest,
): WorkspaceManifest {
  return { ...root, repositories: resolved.repositories };
}

/**
 * Resolve the workspace tree, clone missing repositories, and print results.
 */
async function runInstall(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  manifestPath: string,
  g: GitRunner,
): Promise<number> {
  const targets = opts.subcommand ? [opts.subcommand, ...opts.positional] : [];
  const paths = manifestPaths(manifest, manifestPath);

  const resolved = resolveWorkspaceTree(manifest, manifestPath);
  const flat = flattenResolved(resolved, manifest);

  const scoped = opts.workspace
    ? {
      ...flat,
      repositories: flat.repositories.filter(
        (r) => r.workspace === opts.workspace,
      ),
    }
    : flat;

  const rows = await cloneMissing(g, scoped, paths, targets);
  printRows(rows, opts.json);

  const failed = rows.some(isBadInstallRow);
  if (!failed) {
    console.error(
      `NOTE: Fresh clones do not contain files listed in .gitignore.
Required setup steps may include:
  - Running npm install / deno install / pip install etc. in each repo
  - Copying .env files from secrets/ (run: works env sync)
  - Any repo-specific setup documented in each repo's README`,
    );
  }
  return failed ? 1 : 0;
}

/**
 * Scaffold a brand-new workspace: write a fresh manifest (schema v4) with
 * optional host/owner and seeded shorthand entries, create the standard
 * directories, and point the user at `works install`. Fails closed when any
 * manifest already exists in the target directory; seeds are validated through
 * the same normalize/validate pipeline as an existing manifest before
 * anything is written.
 */
async function runInitScaffold(opts: CliOptions): Promise<number> {
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

  const doc: Record<string, unknown> = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
  if (opts.host !== undefined) {
    doc.host = opts.host;
  }
  if (opts.owner !== undefined) {
    doc.owner = opts.owner;
  }
  doc.repositories = opts.positional;

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
    return await runInitScaffold(opts);
  }

  // add/remove edit the manifest file itself and produce their own friendly
  // errors when it is missing or malformed, so they also skip the shared
  // load below.
  if (opts.command === "add" || opts.command === "remove") {
    const path = opts.manifestPath
      ? resolve(Deno.cwd(), opts.manifestPath)
      : await findDefaultManifestPath();
    return await runManifestEdit(opts, path);
  }

  const manifestPath = opts.manifestPath
    ? resolve(Deno.cwd(), opts.manifestPath)
    : await findDefaultManifestPath();
  const manifest = await loadManifest(manifestPath);
  const g = new SystemGit();

  if (opts.command === "install") {
    return await runInstall(opts, manifest, manifestPath, g);
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

  const resolvedManifest = flattenResolved(resolvedTree, manifest);

  // Handle the workspaces command with resolved data.
  if (opts.command === "workspaces") {
    const workspaces = listWorkspaces(resolvedTree);
    printRows(workspaces, opts.json);
    return 0;
  }

  const paths = manifestPaths(manifest, manifestPath);
  return await runCommand(opts, resolvedManifest, paths, g);
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
