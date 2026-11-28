import { parseArgs } from "@std/cli/parse-args";
import { SystemGit } from "./git.ts";
import {
  detectConflicts,
  loadManifest,
  manifestPaths,
  resolveWorkspaceTree,
} from "./manifest.ts";
import { cliArgs, exit } from "./runtime.ts";
import { flattenResolved, resolveManifestPath } from "./shared.ts";
import type { CliOptions } from "./shared.ts";

import * as addCmd from "./commands/add.ts";
import * as checkCmd from "./commands/check.ts";
import * as initCmd from "./commands/init.ts";
import * as installCmd from "./commands/install.ts";
import * as pathCmd from "./commands/path.ts";
import * as removeCmd from "./commands/remove.ts";
import * as sweepCmd from "./commands/sweep.ts";
import * as updateCmd from "./commands/update.ts";
import * as validateCmd from "./commands/validate.ts";
import * as validateDepsCmd from "./commands/validate-deps.ts";
import * as workspacesCmd from "./commands/workspaces.ts";

const COMMANDS = [
  "check",
  "init",
  "install",
  "add",
  "remove",
  "path",
  "update",
  "sweep",
  "workspaces",
  "validate",
];

const COMMAND_ALIASES: Record<string, string> = {
  i: "install",
};

class CliHelp extends Error {}

function usage(): void {
  console.log(`workspace-cli (wspace)

Usage:
wspace check [--json] [--workspace <name>] [--strict]
  wspace init [--host <host>] [--owner <owner>] [<repo...>]
  wspace install [<repo...>] [--json] [--workspace <name>] [--dry-run] [--force]
  wspace i [<repo...>] [--json] [--workspace <name>] [--dry-run] [--force]  (alias for install)
  wspace add [<name>] [--url <url>] [--name <n>] [--as-workspace] [--create] [--visibility <public|private>]
  wspace remove <repo>
  wspace path <query> [--json]
  wspace update [--json] [--workspace <name>] [--dry-run]
  wspace sweep [--dry-run] [--json] [--delete-remote] [--force] [--strict]
              [--offline] [--workspace <name>]
  wspace workspaces [--json]
  wspace validate [--deps] [--json]

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
  --delete-remote     sweep: also delete origin/<branch> (default: keep remotes)
  --force             sweep: override the merge-proof and clean-tree gates;
                      install: clear empty placeholder dirs that block a clone
  --strict            sweep: exit non-zero on refusals, not only on failures
                      check: exit non-zero on stray (unmanaged) entries too
  --offline           sweep: prove merges from local refs only; never call gh
  --deps              validate: also check the Deno and Bun release-age delay
  --as-workspace       add: place the entry in the workspaces array and require a child manifest

Sweep Command:
  sweep               Remove every linked worktree whose branch is already
                      merged, workspace-wide. Discovers worktrees from
                      git (no on-disk convention) and only deletes after
                      proving the merge. Refusals are reported, not fatal.

Path Command:
  path                Fuzzy-find a workspace directory (repo, sub-workspace).
                        Use in command substitution: cd "$(wspace path workspace-cli)"

Sub-workspaces:
  workspaces         Lists discovered sub-workspaces with repo counts.`);
}

function parseCliArgs(args: string[]): CliOptions {
  const parsed = parseArgs(args, {
    boolean: [
      "help",
      "json",
      "stale",
      "dry-run",
      "create",
      "as-workspace",
      "delete-remote",
      "force",
      "strict",
      "offline",
      "deps",
    ],
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
    deleteRemote: parsed["delete-remote"] ?? false,
    force: parsed.force ?? false,
    strict: parsed.strict ?? false,
    offline: parsed.offline ?? false,
    deps: parsed.deps ?? false,
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

  // validate checks the manifest alone first, then falls through to the same
  // resolution and conflict gate as check/install so it never reports valid
  // for a tree those commands reject (#144).
  if (opts.command === "validate") validateCmd.check(manifest);

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
    case "validate": {
      // `--deps` audits checkouts, so it continues into the resolved tree below.
      const code = validateCmd.report(manifest);
      if (!opts.deps) return code;
    }
  }

  const resolvedManifest = flattenResolved(resolvedTree, manifest);
  const paths = manifestPaths(manifest, manifestPath);

  switch (opts.command) {
    case "validate":
      return await validateDepsCmd.run(opts, resolvedManifest, paths);
    case "check":
      return await checkCmd.run(opts, resolvedManifest, paths, g);
    case "install":
      return await installConverged(opts, manifest, manifestPath, g);
    case "path":
      return await pathCmd.run(opts, resolvedManifest, paths);
    case "update":
      return await updateCmd.run(opts, resolvedManifest, paths, g);
    case "sweep":
      return await sweepCmd.run(opts, resolvedManifest, paths, g);
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
    return await run(cliArgs());
  } catch (error) {
    if (error instanceof CliHelp) {
      return 0;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (import.meta.main) {
  main().then((code) => exit(code));
}
