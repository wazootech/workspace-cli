import { join, resolve } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import { syncEnv } from "./env.ts";
import { clone, defaultBranch } from "./git.ts";
import type { GitRunner } from "./git.ts";
import { SystemGit } from "./git.ts";
import {
  detectConflicts,
  exists,
  findDefaultManifestPath,
  listWorkspaces,
  loadManifest,
  manifestPaths,
  resolveRepositoryPath,
  resolveWorkspaceTree,
  validateManifest,
} from "./manifest.ts";
import type { ManifestPaths } from "./manifest.ts";
import { collectStatus, hasErrors } from "./status.ts";
import type { ResolvedWorkspace, WorkspaceManifest } from "./types.ts";
import type { RepositoryEntry } from "./types.ts";
import { isWorkspaceReference } from "./types.ts";
import { MissingManifestError } from "./manifest.ts";

function clonableReference(entry: RepositoryEntry): boolean {
  return isWorkspaceReference(entry) && Boolean(entry.url);
}
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
  "sync",
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
  wspace init [<repo...>] [--json] [--workspace <name>]
  wspace sync [<repo...>] [--json] [--workspace <name>]
  wspace update [--json] [--workspace <name>]
  wspace worktree add <repo> <feature> [<commit-ish>]
  wspace worktree list [--stale] [--json] [--workspace <name>]
  wspace worktree remove <repo> <feature>
  wspace workspaces [--json]
  wspace env sync [--dry-run] [--json]
  wspace validate

Options:
  --manifest <path>   Manifest path (default: workspace.json / wspace.json / repos.json)
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
    string: ["manifest", "workspace"],
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
    json: parsed.json ?? false,
    stale: parsed.stale ?? false,
    dryRun: parsed["dry-run"] ?? false,
    positional: positional.slice(2),
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
    case "sync":
    case "init": {
      const targets = opts.subcommand
        ? [opts.subcommand, ...opts.positional]
        : [];
      const repos = opts.workspace
        ? manifest.repositories.filter((r) => r.workspace === opts.workspace)
        : manifest.repositories;
      const scopedManifest = { ...manifest, repositories: repos };
      const rows = await cloneMissing(g, scopedManifest, paths, targets);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        console.table(rows);
      }
      const failed = rows.some(
        (r) =>
          r.state === "CLONE_FAILED" ||
          r.state === "PATH_BLOCKED" ||
          r.state === "INVALID" ||
          r.state === "UNKNOWN_REPO",
      );
      if (opts.command === "init" && !failed) {
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

export async function run(args: string[]): Promise<number> {
  const opts = parseCliArgs(args);
  const manifestPath = opts.manifestPath
    ? resolve(Deno.cwd(), opts.manifestPath)
    : await findDefaultManifestPath();
  const manifest = await loadManifest(manifestPath);

  // Resolve the workspace tree if sub-workspaces are declared, either as
  // inline references in repositories (schema v3+) or in a workspaces array
  // (schema v2 style).
  const hasInlineReferences = manifest.repositories.some(isWorkspaceReference);
  const isInitCommand = opts.command === "init" || opts.command === "sync";
  let resolvedManifest = manifest;
  let resolvedTree: ResolvedWorkspace | undefined;
  if (
    hasInlineReferences ||
    (manifest.workspaces && manifest.workspaces.length > 0)
  ) {
    let resolved: ResolvedWorkspace;
    try {
      resolved = await resolveWorkspaceTree(manifest, manifestPath);
    } catch (error) {
      // Bootstrap: init may clone reference repositories that carry a url,
      // making the child manifests readable on a fresh checkout. Retry once
      // after cloning; every other command gets an actionable hint.
      const isMissingManifest = error instanceof MissingManifestError;
      if (!isInitCommand || !isMissingManifest) {
        if (
          isMissingManifest && manifest.repositories.some(clonableReference)
        ) {
          throw new Error(
            `${error.message}\nRun 'wspace init' to clone it.`,
          );
        }
        throw error;
      }
      const targets = opts.subcommand
        ? [opts.subcommand, ...opts.positional]
        : [];
      const bootstrapRefs = manifest.repositories.filter((r) =>
        clonableReference(r) &&
        (targets.length === 0 || targets.includes(r.name))
      );
      if (bootstrapRefs.length === 0) throw error;
      const bootstrapPaths = manifestPaths(manifest, manifestPath);
      const bootstrapRows = await cloneMissing(
        new SystemGit(),
        { ...manifest, repositories: bootstrapRefs },
        bootstrapPaths,
      );
      if (opts.json) {
        console.log(JSON.stringify(bootstrapRows, null, 2));
      } else {
        console.table(bootstrapRows);
      }
      resolved = await resolveWorkspaceTree(manifest, manifestPath);
    }
    resolvedTree = resolved;

    // Detect conflicts.
    const conflicts = detectConflicts(resolved);
    if (conflicts.length > 0) {
      console.error("ERROR: Duplicate repository names across workspaces:");
      for (const c of conflicts) {
        console.error(
          `  "${c.repoName}" claimed by: ${c.claimedBy.join(", ")}`,
        );
      }
      return 2;
    }

    // Build a merged manifest from the resolved tree. References carrying a
    // url are repository entries like any other (clone target for init,
    // status/update/worktree subject elsewhere); url-less references stay
    // pure delegation pointers.
    resolvedManifest = {
      ...manifest,
      repositories: [
        ...resolved.repositories,
        ...resolved.references.filter((r) => r.url),
      ],
    };
  }

  // Handle the workspaces command with resolved data.
  if (opts.command === "workspaces") {
    const wsResolved = resolvedTree ?? {
      root: manifest,
      children: new Map<string, WorkspaceManifest>(),
      repositories: manifest.repositories,
      references: [],
    };
    const workspaces = listWorkspaces(wsResolved);
    if (opts.json) {
      console.log(JSON.stringify(workspaces, null, 2));
    } else {
      console.table(workspaces);
    }
    return 0;
  }

  const paths = manifestPaths(manifest, manifestPath);
  return await runCommand(opts, resolvedManifest, paths, new SystemGit());
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
