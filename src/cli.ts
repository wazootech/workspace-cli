import { join, resolve } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import { syncEnv } from "./env.ts";
import { clone } from "./git.ts";
import type { GitRunner } from "./git.ts";
import { SystemGit } from "./git.ts";
import {
  exists,
  loadManifest,
  manifestPaths,
  resolveRepositoryPath,
  validateManifest,
} from "./manifest.ts";
import type { ManifestPaths } from "./manifest.ts";
import { collectStatus, hasErrors } from "./status.ts";
import type { WorkspaceManifest } from "./types.ts";
import { runUpdate } from "./update.ts";
import { addWorktree, listWorktrees, removeWorktree } from "./worktrees.ts";

const COMMANDS = ["check", "sync", "update", "worktree", "env", "validate"];

class CliHelp extends Error {}

interface CliOptions {
  command: string;
  subcommand?: string;
  manifestPath: string;
  json: boolean;
  stale: boolean;
  positional: string[];
}

function usage(): void {
  console.log(`workspace-cli (wspace)

Usage:
  wspace check [--json]
  wspace sync [--json]
  wspace update [--json]
  wspace worktree add <repo> <feature>
  wspace worktree list [--stale] [--json]
  wspace worktree remove <repo> <feature>
  wspace env sync
  wspace validate

Options:
  --manifest <path>  Manifest path (default: repos.json)
  --json             Machine-readable output`);
}

function parseCliArgs(args: string[]): CliOptions {
  const parsed = parseArgs(args, {
    boolean: ["help", "json", "stale"],
    string: ["manifest"],
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
    manifestPath: parsed.manifest ?? "repos.json",
    json: parsed.json ?? false,
    stale: parsed.stale ?? false,
    positional: positional.slice(2),
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
      }[] = [];
      for (const repository of manifest.repositories) {
        const repoPath = resolveRepositoryPath(repository, paths);
        if (!(await exists(repoPath))) {
          continue;
        }
        for (const wt of await listWorktrees(g, repoPath)) {
          rows.push({
            repo: repository.name,
            path: wt.path,
            branch: wt.branch,
            bare: wt.bare,
            detached: wt.detached,
          });
        }
      }
      const filtered = opts.stale ? rows.filter((r) => r.detached) : rows;
      if (opts.json) {
        console.log(JSON.stringify(filtered, null, 2));
      } else {
        console.table(filtered);
      }
      return 0;
    }
    case "add": {
      const [repoName, feature] = opts.positional;
      if (!repoName || !feature) {
        console.error("Usage: wspace worktree add <repo> <feature>");
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
      const result = await addWorktree(g, repoPath, worktreePath, feature);
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
      console.log(`Removed worktree ${worktreePath}`);
      return 0;
    }
    default:
      console.error("Usage: wspace worktree add|list|remove");
      return 2;
  }
}

async function runCommand(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
  g: GitRunner,
): Promise<number> {
  switch (opts.command) {
    case "check": {
      const rows = await collectStatus(g, manifest, paths);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        console.table(rows);
      }
      return hasErrors(rows) ? 1 : 0;
    }
    case "sync": {
      await Deno.mkdir(paths.repositoriesDirectory, { recursive: true });
      const rows: { name: string; state: string; detail?: string }[] = [];
      for (const repository of manifest.repositories) {
        const repoPath = resolveRepositoryPath(repository, paths);
        if (await exists(repoPath)) {
          rows.push({ name: repository.name, state: "EXISTS" });
          continue;
        }
        const result = await clone(g, repository.url, repoPath);
        rows.push(
          result.code === 0 ? { name: repository.name, state: "CLONED" } : {
            name: repository.name,
            state: "CLONE_FAILED",
            detail: result.stderr,
          },
        );
      }
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        console.table(rows);
      }
      return 0;
    }
    case "update": {
      const rows = await runUpdate(g, manifest, paths);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        console.table(rows);
      }
      return 0;
    }
    case "worktree":
      return await runWorktree(opts, manifest, paths, g);
    case "env": {
      if (opts.subcommand !== "sync") {
        console.error("Usage: wspace env sync");
        return 2;
      }
      const rows = await syncEnv(g, manifest, paths);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        console.table(rows);
      }
      return 0;
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
  const manifestPath = resolve(Deno.cwd(), opts.manifestPath);
  const manifest = await loadManifest(manifestPath);
  const paths = manifestPaths(manifest, manifestPath);
  return await runCommand(opts, manifest, paths, new SystemGit());
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
