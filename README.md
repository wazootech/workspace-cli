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
- `wspace add [<name>] [--url <url>] [--name <n>] [--create]
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

The manifest is `workspace.json` in `.json` format (JSONC allows comments and
trailing commas). Discovery is name-first, then extension.

Schema v4 keeps one `repositories` array with exactly two entry forms:

1. **Shorthand** — `"repo"`, `"owner/repo"`, or
   `{ "name": "...", "owner": "..." }` expands against the manifest's `host`
   (default `github.com`) to `https://<host>/<owner>/<name>.git`.
2. **Object** — `{ "name": "...", "url": "..." }` is a plain repository for any
   Git host.

```json
{
  "schemaVersion": 4,
  "host": "github.com",
  "owner": "acme",
  "repositories": [
    "shared-reference",
    "other-owner/forked-repo",
    { "name": "elsewhere", "url": "https://gitlab.com/other/repo.git" }
  ]
}
```

Shorthand rules: `owner/name` overrides the top-level `owner` per entry; exactly
one slash is allowed; `url` and `owner` are mutually exclusive on object
entries.

## Local names and collisions

A repository's local checkout directory is always
`<repositoriesDirectory>/<name>`, where `name` is the post-expansion label:
ownership and hosts live in URLs, never in paths. Names therefore cannot contain
slashes, backslashes, or path traversal, and two entries resolving to the same
label are rejected — including a shorthand colliding with another entry's
expanded name.

To check out a repository under a different label than its shorthand name, write
the explicit form with your chosen label as `name`:

```json
{
  "name": "wazootech__memsdk",
  "url": "https://github.com/wazootech/memsdk.git"
}
```

The aliased copy is an ordinary explicit-url entry.

`wspace install` converges in one invocation: each pass clones what is missing,
re-resolves the tree (newly cloned containers may reveal detected
sub-workspaces), and repeats until nothing new appears. Every other command
resolves once against whatever is currently on disk.

Each child manifest is a standard manifest: its repositories resolve against its
own root (defaulting to `repos/` under the directory containing the child
manifest), and it may compose further sub-workspaces through its own bare
strings. Resolution errors on circular references and duplicate repository
claims across workspaces; a detected manifest that was already visited (for
example a repository hosting its own root manifest) degrades silently to a plain
repository row. Child manifests are self-contained: their own `host` and `owner`
apply, and nothing is inherited from the parent.

Schema v4 migration notes: the separate `workspaces` array was removed — child
workspaces now compose automatically through detection. Entry fields `path`,
`groups`, `localFiles`, and `manifest` were removed; entries are bare strings or
`{ "name", "url" }`. Legacy `vaultDirectory` and `workspaces` are rejected with
pointed errors; `worktreesDirectory`, `secretsDirectory`, and removed entry
fields such as `path` are silently ignored (the published JSON schema flags
unknown keys via `additionalProperties: false`).

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
