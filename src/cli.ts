import { parseArgs } from "@std/cli/parse-args";
import { SystemGit } from "./git.ts";
import {
  detectConflicts,
  loadManifest,
  manifestPaths,
  resolveWorkspaceTree,
} from "./manifest.ts";
import { flattenResolved, resolveManifestPath } from "./shared.ts";
import type { CliOptions } from "./shared.ts";

import * as addCmd from "./commands/add.ts";
import * as checkCmd from "./commands/check.ts";
import * as envCmd from "./commands/env.ts";
import * as initCmd from "./commands/init.ts";
import * as installCmd from "./commands/install.ts";
import * as pathCmd from "./commands/path.ts";
import * as removeCmd from "./commands/remove.ts";
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
  "path",
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
  console.log(`workspace-cli (wspace)

Usage:
wspace check [--json] [--workspace <name>]
  wspace init [--host <host>] [--owner <owner>] [<repo...>]
  wspace install [<repo...>] [--json] [--workspace <name>] [--dry-run]
  wspace i [<repo...>] [--json] [--workspace <name>] [--dry-run]      (alias for install)
  wspace add [<name>] [--url <url>] [--name <n>] [--create] [--visibility <public|private>]
  wspace remove <repo>
  wspace path <query> [<feature>] [--workspace <name>] [--json]
  wspace update [--json] [--workspace <name>] [--dry-run]
  wspace worktree add <repo> <feature> [<commit-ish>] [--dry-run]
  wspace worktree list [--stale] [--json] [--workspace <name>]
  wspace worktree remove <repo> <feature> [--dry-run]
  wspace workspaces [--json]
  wspace env sync [--dry-run] [--json]
  wspace validate

Options:
  --manifest <path>   Manifest path (default: workspace.json)
  --host <host>       init: hostname for shorthand expansion (default: github.com)
  --owner <owner>     init: owner for shorthand entries
  --url <url>         add: explicit clone URL (writes an object entry)
  --name <n>          add: local name when using --url (defaults to URL basename)
  --create            add: create a missing GitHub repository before adding
  --visibility <v>    add: visibility used with --create (private|public; default private)
  --json              Machine-readable output
  --stale             Filter worktrees fully merged into origin/<default> (or missing branch)
  --dry-run           Preview write operations without modifying files or running network calls
  --workspace <name>  Scope command to a specific sub-workspace (by name)

Path Command:
  path                Print the path to a repo or worktree. Use in command substitution:
                        cd "$(wspace path workspace-cli)"
                        cd "$(wspace path workspace-cli --feature my-branch)"

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

export async function run(args: string[]): Promise<number> {
  const opts = parseCliArgs(args);

  switch (opts.command) {
    case "init":
      // init scaffolds a brand-new workspace; it must not require an existing
      // manifest.
      return await initCmd.run(opts);
    case "add":
      // add/remove edit the manifest file itself and produce their own
      // friendly errors when it is missing or malformed.
      return await addCmd.run(opts);
    case "remove":
      return await removeCmd.run(opts);
  }

  const manifestPath = await resolveManifestPath(opts);
  const manifest = await loadManifest(manifestPath);
  const g = new SystemGit();

  switch (opts.command) {
    case "install":
      return await installCmd.run(opts, manifest, manifestPath, g);
    case "validate":
      return await validateCmd.run(manifest);
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

  switch (opts.command) {
    case "workspaces":
      return await workspacesCmd.run(opts, resolvedTree);
  }

  const resolvedManifest = flattenResolved(resolvedTree, manifest);
  const paths = manifestPaths(manifest, manifestPath);

  switch (opts.command) {
    case "check":
      return await checkCmd.run(opts, resolvedManifest, paths, g);
    case "path":
      return pathCmd.run(opts, resolvedManifest, paths);
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
