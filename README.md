<p align="center">
  <a href="https://docs.wazoo.dev">
    <img src="https://wazoo.dev/assets/wazoo.svg" alt="Wazoo Worlds" width="120" />
  </a>
  <br /><br />
  <em>Git-native CLI for the Wazoo multi-repo workspace.</em>
  <br /><br />
  <a href="https://jsr.io/@wazoo/workspace"><img src="https://jsr.io/badges/@wazoo/workspace" alt="JSR" /></a>
  <a href="https://jsr.io/@wazoo/workspace/score"><img src="https://jsr.io/badges/@wazoo/workspace/score" alt="JSR Score" /></a>
  <a href="https://github.com/wazootech/workspace-cli"><img src="https://img.shields.io/badge/GitHub-black?logo=github" alt="GitHub" /></a>
  <a href="https://deepwiki.com/wazootech/workspace-cli"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" /></a>
</p>

# wspace — Wazoo workspace CLI

## Goal

`wspace` is a small, git-native CLI that manages a multi-repo Wazoo workspace
without Git submodules. It keeps the working rules in one place and makes them
enforceable from the terminal.

Design principles:

- **Thin over custom.** Prefer plain `git` porcelain/plumbing and well-known
  directory conventions over bespoke state files. The workspace layout is
  encoded in a single `workspace.json` manifest.
- **Conservative mutation.** Commands that write or move state (update, update
  refuses to touch dirty repositories, feature branches, missing repos, or
  unmanaged checkouts. `update` only fetches and fast-forwards clean default
  branches; it never resets, rebases, stashes, or rewrites history. When the
  workspace root is itself a git checkout, `update` treats it like any other
  clean default branch and `check` reports it as `(workspace root)`. The root's
  dirty probe ignores untracked files, so its own `repos/` and `worktrees/`
  contents never mark it dirty. Scoped runs (`--workspace <name>`) leave the
  root out entirely.
- **Machine-readable output.** `check --json` emits structured results for
  tools; plain output is for humans.
- **Exit code contract.** `wspace check` exits `0` when the workspace is clean
  and `1` when any repository is dirty, diverged, missing, or otherwise not in
  sync.

## Commands

- `wspace check` — read-only baseline check. Reports `CLEAN`, `DIRTY`,
  `FEATURE_CLEAN`, `DIVERGED`, `UNKNOWN`, `MISSING`, and `UNMANAGED` states.
  When the workspace root directory is itself a git checkout, it is reported
  first as `(workspace root)` and non-clean states fail the check. Untracked
  files at the root never count as dirty, and `--workspace <name>` checks only
  the named sub-workspace.
- `wspace init [--host <host>] [--owner <owner>] [<repo...>]` — one-time
  scaffold for an empty directory: writes a fresh `workspace.json` (schema v4)
  with optional host/owner and seeded shorthand entries, and creates the
  standard `repos/` directory. Fails closed if any manifest already exists.
- `wspace install [<repo...>]` — clone missing repositories from the manifest
  (or only a specified subset of repos). Prints a warning that fresh clones lack
  gitignored files and repo-specific setup.
- `wspace add [<name>] [--url <url>] [--name <n>] [--as-workspace] [--create]
  [--visibility <public|private>]`
  — append an entry to the manifest: a bare or `owner/name` shorthand string, or
  an object entry via `--url` (name defaults to the URL basename, overridable
  with `--name` or a positional name). Edits are surgical manifests survive.
  GitHub shorthand entries are probed with `gh`; pass `--create` to create a
  missing repository first (default private). Nothing is cloned; run
  `wspace install <name>` afterwards.
- `wspace remove <repo>` — delete the entry whose effective name matches.
  Surgical edit; local checkouts are never deleted.
- `wspace update` — fetch remotes and fast-forward only clean default branches,
  including the workspace root's own checkout when it is a git repository.
  Untracked workspace content (`repos/`, `worktrees/`) does not mark the root
  dirty. `--workspace <name>` updates only the named sub-workspace and leaves
  the root out.
- `wspace validate` — validate the manifest without touching any repository.
- `wspace workspaces [--json]` — list discovered sub-workspaces with repo
  counts. `check`, `install`, and `update` accept `--workspace <name>` to scope
  the command to one sub-workspace.

## Sub-workspaces

A manifest keeps ordinary repositories and workspace repositories in separate
arrays. Workspace checkouts live in `workspacesDirectory` when it is set;
otherwise they share `repositoriesDirectory` with ordinary repositories. Both
arrays accept the same shorthand and object entry forms. A `workspaces` entry
is cloned at `<workspacesDirectory>/<name>` (or
`<repositoriesDirectory>/<name>` when unset) and must contain a valid
`workspace.json` manifest; its child repositories use that child manifest's own
`repos/` directory. This makes the checkout location deterministic without
guessing whether a repository is also a workspace.

```json
{
  "schemaVersion": 4,
  "owner": "acme",
  "workspacesDirectory": "workspaces",
  "repositories": ["shared-reference"],
  "workspaces": ["platform-workspace"]
}
```

Shorthand rules: `owner/name` overrides the top-level `owner` per entry; exactly
one slash is allowed; and `url` and `owner` are mutually exclusive on object
entries.

Use `wspace add --as-workspace` to add a workspace entry. `install` and `check`
verify that declared workspace repositories contain a valid child manifest, and
commands report ordinary repositories and workspace repositories without
collisions.

`wspace install` clones all missing entries from both arrays. A declared
workspace is validated as a Git repository containing `workspace.json`; once
present, its child repositories are resolved against that child workspace's own
`repos/` directory. `--workspace <name>` scopes operations to repositories owned
by that child workspace.

Schema v4 keeps ordinary repositories and workspace repositories in separate
arrays. This is intentional: `repositoriesDirectory` remains the source of
truth for ordinary checkout locations, and the optional `workspacesDirectory`
separates workspace checkouts when the manifest declares one. The arrays use
the same shorthand and object entry forms, and names must be unique across both
arrays.

## Local names and collisions

An ordinary repository's local checkout directory is always
`<repositoriesDirectory>/<name>`; a workspace repository's is
`<workspacesDirectory>/<name>` when configured, otherwise
`<repositoriesDirectory>/<name>`. `name` is the post-expansion label: ownership
and hosts live in URLs, never in paths. Names therefore cannot contain
slashes, backslashes, or path traversal. Two entries conflict only when they
resolve to the same checkout path — including a shorthand colliding with
another entry's expanded name within one workspace. The same name may appear in
different workspaces because each workspace's checkouts live in its own
directory (`./workspaces/wazootech/repos/memory` and `./repos/memory` can
coexist).

To check out a repository under a different label than its shorthand name, write
the explicit form with your chosen label as `name`:

```json
{
  "name": "wazootech__memsdk",
  "url": "https://github.com/wazootech/memsdk.git"
}
```

The aliased copy is an ordinary explicit-url entry.

Manifest discovery has been simplified to `workspace.json` only. The
`wspace.json` and `repos.json` filename fallbacks and `.yaml` / `.yml` format
support have been removed. Migrate by renaming your manifest file to
`workspace.json` and converting any YAML manifests to JSON. The CLI auto-detects
the manifest by walking up from the current directory (like
`git rev-parse --show-toplevel`). Pass `--manifest <path>` to override
auto-detection.

## Agent skills

The [`wspace` agent skill](skills/wspace/SKILL.md) packages the same workspace
discipline into a loadable skill for coding agents (Claude Code, Cursor,
OpenCode, Gemini, and others). It is not a thin wrapper around the CLI — it
encodes a set of opinionated software engineering practices that apply to any
multi-repo workspace:

- **Worktree isolation as default.** The skill makes "never edit the canonical
  checkout" the only path, not an opt-in. Eliminates an entire class of "oops I
  was on main" incidents across any multi-repo setup.
- **Single-round-trip discovery.** `wspace check --json` replaces per-repo `ls`
  and `git status` probing. Fewer tool calls means faster time to the first
  useful action and less context consumed per session.
- **Pipeline with verifiable exit conditions.** Each step ends on a checkable
  artifact — a clean worktree, green CI, a merged PR — not agent reasoning about
  whether things look right.
- **Goal loop with hard boundaries.** The FRAME-SCAN-CLAIM-EXECUTE-REFLECT loop,
  with deploy, publish, and human-in-the-loop hard stops, is a reusable autonomy
  pattern for driving any multi-repo backlog to completion.
- **Token and context economy.** Batch commands into single shell calls, hand
  off plan artifacts between phases (not full conversations), and leave per-repo
  command syntax in reference files loaded on demand.

```bash
npx skills add wazootech/workspace-cli@wspace
```

The skill reads the workspace manifest and CLI the same way a human would — but
it never needs to be taught the conventions twice.

## Install

Install from JSR as the `wspace` binary:

```sh
deno install -g -A --name wspace jsr:@wazoo/workspace/cli
```

Use the `/cli` subpath export — the runnable CLI entry — not the bare
`jsr:@wazoo/workspace` package (which exposes the library and produces a no-op
`wspace` when installed globally). `-A` grants the read/write/run permissions
`wspace` needs; omit it if you prefer to grant specific flags (e.g.
`--allow-read --allow-write --allow-run=git`) or use Prompts.

Or build a local binary:

```sh
deno task build
```

Requires a Deno runtime (v2+). The `wspace` binary has no runtime dependencies.

## Development

```sh
deno task ci
```

Runs `deno fmt --check`, `deno lint`, `deno check`, and `deno test` (includes
integration tests against real local git repositories).

## Docs

- [ADR-0002: Conservative update policy](docs/adr/0002-conservative-update-policy.md)
- [ADR-0004: The wspace command name](docs/adr/0004-wspace-command-name.md)
