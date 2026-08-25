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
} from "./manifest.ts";
import type { ManifestPaths } from "./manifest.ts";
import { exists } from "@std/fs";
import { collectStatus, hasErrors } from "./status.ts";
import type { ResolvedWorkspace, WorkspaceManifest } from "./types.ts";

/** Defensive cap on install convergence passes; cycle detection fires first. */
const MAX_INSTALL_PASSES = 16;
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
  json: boolean;
  stale: boolean;
  dryRun: boolean;
  positional: string[];
  workspace?: string;
}

function usage(): void {
  console.log(`workspace-cli (wspace)

Usage:
  wspace check [--json] [--workspace <name>]
  wspace init [--host <host>] [--owner <owner>] [<repo...>]
  wspace install [<repo...>] [--json] [--workspace <name>]
  wspace update [--json] [--workspace <name>]
  wspace worktree add <repo> <feature> [<commit-ish>]
  wspace worktree list [--stale] [--json] [--workspace <name>]
  wspace worktree remove <repo> <feature>
  wspace workspaces [--json]
  wspace env sync [--dry-run] [--json]
  wspace validate

Options:
  --manifest <path>   Manifest path (default: workspace.json / wspace.json / repos.json)
  --host <host>       init: hostname for shorthand expansion (default: github.com)
  --owner <owner>     init: owner for shorthand entries
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
    boolean: ["help", "json", "stale", "dry-run"],
    string: ["manifest", "workspace", "host", "owner"],
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
          "Usage: wspace worktree add <repo> <feature> [<commit-ish>]",
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
        console.error("Usage: wspace worktree remove <repo> <feature>");
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
      console.error("Usage: wspace worktree add|list|remove");
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
      // Install runs through the converging fixpoint in runInstallConverging
      // before runCommand is reached; this case only handles misuse.
      console.error(
        "Usage: wspace install [<repo...>] [--json] [--workspace <name>]",
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
        console.error("Usage: wspace env sync [--dry-run] [--json]");
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
 * Drive install to convergence: resolve the tree (detecting sub-workspaces that
 * only became readable after this pass's clones), clone what is missing, and
 * repeat until a pass clones nothing new. Scoped targets stay single-pass.
 */
async function runInstallConverging(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  manifestPath: string,
  g: GitRunner,
): Promise<number> {
  const targets = opts.subcommand ? [opts.subcommand, ...opts.positional] : [];
  const paths = manifestPaths(manifest, manifestPath);
  const latest = new Map<string, InstallRow>();
  let failed = false;

  for (let pass = 0; pass < MAX_INSTALL_PASSES; pass++) {
    const resolved = await resolveWorkspaceTree(manifest, manifestPath);
    const flat = flattenResolved(resolved, manifest);

    const scoped = opts.workspace
      ? {
        ...flat,
        repositories: flat.repositories.filter(
          (r) => r.workspace === opts.workspace,
        ),
      }
      : flat;
    const passRows = await cloneMissing(g, scoped, paths, targets);
    const fresh = passRows.filter(
      (r) => latest.get(r.name)?.state !== r.state,
    );
    printRows(fresh, opts.json);
    for (const row of passRows) latest.set(row.name, row);

    if (passRows.some(isBadInstallRow)) {
      failed = true;
      break;
    }
    const clonedNow = passRows.some((r) => r.state === "CLONED");
    if (!clonedNow || targets.length > 0) break;
  }

  if (!failed) {
    console.error(
      `NOTE: Fresh clones do not contain files listed in .gitignore.
Required setup steps may include:
  - Running npm install / deno install / pip install etc. in each repo
  - Copying .env files from secrets/ (run: wspace env sync)
  - Any repo-specific setup documented in each repo's README`,
    );
  }
  return failed ? 1 : 0;
}

/**
 * Scaffold a brand-new workspace: write a fresh manifest (schema v4) with
 * optional host/owner and seeded shorthand entries, create the standard
 * directories, and point the user at `wspace install`. Fails closed when any
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
    console.log("Next: run `wspace install` to clone the listed repositories.");
  }
  return 0;
}

export async function run(args: string[]): Promise<number> {
  const opts = parseCliArgs(args);

  // init scaffolds a brand-new workspace; it must not require an existing
  // manifest, so it short-circuits before manifest loading.
  if (opts.command === "init") {
    return await runInitScaffold(opts);
  }

  const manifestPath = opts.manifestPath
    ? resolve(Deno.cwd(), opts.manifestPath)
    : await findDefaultManifestPath();
  const manifest = await loadManifest(manifestPath);
  const g = new SystemGit();

  if (opts.command === "install") {
    return await runInstallConverging(opts, manifest, manifestPath, g);
  }

  // Every other command resolves once; detected sub-workspaces reflect
  // whatever is currently on disk.
  const resolvedTree = await resolveWorkspaceTree(manifest, manifestPath);

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
