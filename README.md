# wspace — Wazoo workspace CLI

## Goal

`wspace` is a small, git-native CLI that manages a multi-repo Wazoo workspace
without Git submodules. It keeps the working rules in one place and makes them
enforceable from the terminal.

Design principles:

- **Thin over custom.** Prefer plain `git` porcelain/plumbing and well-known
  directory conventions over bespoke state files. The workspace layout is
  encoded in a single `repos.json` manifest.
- **Conservative mutation.** Commands that write or move state (update,
  worktree, env) refuse to touch dirty repositories, feature branches, missing
  repos, or unmanaged checkouts. `update` only fetches and fast-forwards clean
  default branches; it never resets, rebases, stashes, or rewrites history.
- **Machine-readable output.** `check --json` emits structured results for
  tools; plain output is for humans.
- **Exit code contract.** `wspace check` exits `0` when the workspace is clean
  and `1` when any repository is dirty, diverged, missing, or otherwise not in
  sync.

## Commands

- `wspace check` — read-only baseline check. Reports `CLEAN`, `DIRTY`,
  `FEATURE_CLEAN`, `DIVERGED`, `UNKNOWN`, `MISSING`, and `UNMANAGED` states.
- `wspace init` — clone missing repositories from the manifest. Prints a warning
  that fresh clones lack gitignored files and repo-specific setup.
- `wspace update` — fetch remotes and fast-forward only clean default branches.
- `wspace worktree add <repo> <feature> [<commit-ish>]` — create a git worktree
  under `worktrees/<repo>/<feature>/`, branching from the repo's default-branch
  baseline (`origin/<default>`) or an explicit `<commit-ish>`. Attaches an
  existing branch of the same name with a warning.
- `wspace worktree list [--stale] [--json]` — list worktrees across all
  repositories. `--stale` filters to linked worktrees whose branch is fully
  merged into the default branch (or missing), i.e. safe removal candidates.
- `wspace worktree remove <repo> <feature>` — remove a worktree, then prune and
  tidy the now-empty `worktrees/<repo>/` directory.
- `wspace env sync` — copy local environment files from a gitignored `secrets/`
  vault into checkouts and worktrees.
- `wspace sync` — alias for `wspace init`.
- `wspace validate` — validate the manifest without touching any repository.

## Install

Install from JSR as the `wspace` binary:

```sh
deno install -g --name wspace jsr:@wazoo/workspace
```

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

- [ADR-0001: Git-native worktrees](docs/adr/0001-git-native-worktrees.md)
- [ADR-0002: Conservative update policy](docs/adr/0002-conservative-update-policy.md)
- [ADR-0003: Explicit worktree baseline and merged-branch staleness](docs/adr/0003-worktree-baseline-and-staleness.md)
