# wsc — Wazoo workspace CLI

## Goal

`wsc` is a small, git-native CLI that manages a multi-repo Wazoo workspace
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
- **Exit code contract.** `wsc check` exits `0` when the workspace is clean and
  `1` when any repository is dirty, diverged, missing, or otherwise not in sync.

## Commands

- `wsc check` — read-only baseline check. Reports `CLEAN`, `DIRTY`,
  `FEATURE_CLEAN`, `DIVERGED`, `UNKNOWN`, `MISSING`, and `UNMANAGED` states.
- `wsc update` — fetch remotes and fast-forward only clean default branches.
- `wsc worktree add|list|remove` — create, list, and remove git worktrees under
  `worktrees/<repo>/<feature>/`.
- `wsc env sync` — copy local environment files from a gitignored `secrets/`
  vault into checkouts and worktrees.
- `wsc sync` — convenience alias that runs update + env sync.
- `wsc validate` — validate the manifest without touching any repository.

## Install

Build a local binary:

```sh
deno task build
```

Requires a Deno runtime (v2+). The `wsc` binary has no runtime dependencies.

## Development

```sh
deno task ci
```

Runs `deno fmt --check`, `deno lint`, `deno check`, and `deno test` (includes
integration tests against real local git repositories).

## Docs

- [ADR-0001: Git-native worktrees](docs/adr/0001-git-native-worktrees.md)
- [ADR-0002: Conservative update policy](docs/adr/0002-conservative-update-policy.md)
