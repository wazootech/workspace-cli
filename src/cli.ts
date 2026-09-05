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
import * as initCmd from "./commands/init.ts";
import * as installCmd from "./commands/install.ts";
import * as pathCmd from "./commands/path.ts";
import * as removeCmd from "./commands/remove.ts";
import * as updateCmd from "./commands/update.ts";
import * as validateCmd from "./commands/validate.ts";
import * as workspacesCmd from "./commands/workspaces.ts";

const COMMANDS = [
  "check",
  "init",
  "install",
  "add",
  "remove",
  "path",
  "update",
  "workspaces",
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
  wspace add [<name>] [--url <url>] [--name <n>] [--as-workspace] [--create] [--visibility <public|private>]
  wspace remove <repo>
  wspace path <query> [--json]
  wspace update [--json] [--workspace <name>] [--dry-run]
  wspace workspaces [--json]
  wspace validate

Options:
  --manifest <path>   Manifest path override (default: auto-detected by walking
                        up from cwd for workspace.json)
  --host <host>       init: hostname for shorthand expansion (default: github.com)
  --owner <owner>     init: owner for shorthand entries
  --url <url>         add: explicit clone URL (writes an object entry)
  --name <n>          add: local name when using --url (defaults to URL basename)
  --create            add: create a missing GitHub repository before adding
  --visibility <v>    add: visibility used with --create (private|public; default private)
  --json              Machine-readable output
  --dry-run           Preview write operations without modifying files or running network calls
  --workspace <name>  Scope command to a specific sub-workspace (by name)
  --as-workspace       add: place the entry in the workspaces array and require a child manifest

Path Command:
  path                Fuzzy-find a workspace directory (repo, sub-workspace).
                        Use in command substitution: cd "$(wspace path workspace-cli)"

Sub-workspaces:
  workspaces         Lists discovered sub-workspaces with repo counts.`);
}

function parseCliArgs(args: string[]): CliOptions {
  const parsed = parseArgs(args, {
    boolean: ["help", "json", "stale", "dry-run", "create", "as-workspace"],
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
    dryRun: parsed["dry-run"] ?? false,
    positional: positional.slice(1),
    workspace: parsed.workspace,
    asWorkspace: parsed["as-workspace"] ?? false,
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
    case "validate":
      return await validateCmd.run(manifest);
  }

  // Every command below resolves once; detected sub-workspaces reflect
  // whatever is currently on disk.
  const resolvedTree = await resolveWorkspaceTree(manifest, manifestPath);

  // Detect conflicts.
  const conflicts = detectConflicts(resolvedTree);
  if (conflicts.length > 0) {
    console.error("ERROR: Duplicate repository checkouts across workspaces:");
    for (const c of conflicts) {
      console.error(
        `  "${c.repoName}" at ${c.path} claimed by: ${c.claimedBy.join(", ")}`,
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
    case "install":
      return await installConverged(opts, manifest, manifestPath, g);
    case "path":
      return await pathCmd.run(opts, resolvedManifest, paths);
    case "update":
      return await updateCmd.run(opts, resolvedManifest, paths, g);
    default:
      return 2;
  }
}

async function installConverged(
  opts: CliOptions,
  rootManifest: Awaited<ReturnType<typeof loadManifest>>,
  manifestPath: string,
  g: SystemGit,
): Promise<number> {
  let tree = await resolveWorkspaceTree(rootManifest, manifestPath);
  let code = await installCmd.run(
    opts,
    flattenResolved(tree, rootManifest),
    manifestPaths(rootManifest, manifestPath),
    g,
  );
  if (code !== 0 || opts.dryRun || opts.positional.length > 0) return code;

  for (let pass = 0; pass < 32; pass++) {
    const next = await resolveWorkspaceTree(rootManifest, manifestPath);
    if (next.repositories.length === tree.repositories.length) return code;
    tree = next;
    code = await installCmd.run(
      opts,
      flattenResolved(tree, rootManifest),
      manifestPaths(rootManifest, manifestPath),
      g,
    );
    if (code !== 0) return code;
  }
  throw new Error(
    "Workspace resolution did not converge after 32 install passes",
  );
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
