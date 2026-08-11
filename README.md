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
- `wspace init [<repo...>]` — clone missing repositories from the manifest (or
  only a specified subset of repos). Prints a warning that fresh clones lack
  gitignored files and repo-specific setup.
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

## Beginner Worktree Lifecycle

All workspace commands run from the workspace root (the directory containing
`repos.json`). When creating worktrees for parallel feature development, always
follow this standard lifecycle:

1. **Check workspace status**:
   ```sh
   wspace check
   ```
2. **Refresh clean default branches**:
   ```sh
   wspace update
   ```
3. **Create a feature worktree**:
   ```sh
   git -C repos/<repo> worktree add "$PWD/worktrees/<repo>/<feature>" -b <feature>
   ```
   _(Or using `wspace`: `wspace worktree add <repo> <feature>`)_
4. **Develop inside the worktree**:
   ```sh
   cd worktrees/<repo>/<feature>
   # make edits, run tests, commit changes
   ```
5. **Sync local secrets when needed**:
   ```sh
   wspace env sync --dry-run   # preview changes
   wspace env sync             # copy secrets with mode 0600 permissions
   ```
6. **Push and open a PR**:
   ```sh
   git push -u origin <feature>
   gh pr create
   ```
7. **Find stale worktrees after PR merge**:
   ```sh
   wspace worktree list --stale
   ```
8. **Clean up merged worktree**:
   ```sh
   wspace worktree remove <repo> <feature>
   ```

### Important Path Resolution Rules

- **Workspace Root Anchor**: All repository and worktree paths in
  `workspace.json` (or `wspace.json` / `repos.json`) resolve relative to the
  directory containing the manifest file, regardless of the caller's current
  working directory.
- **Why `$PWD` is required with `git -C`**: `git -C repos/<repo>` changes Git's
  working directory to `repos/<repo>` before executing. If you pass a relative
  path like `worktrees/<repo>/<feature>`, Git creates the worktree nested inside
  `repos/<repo>/worktrees/...` instead of at the workspace root. Using
  `"$PWD/worktrees/<repo>/<feature>"` resolves `$PWD` from the workspace root
  before Git runs.
- **Default Worktree Baseline**: `wspace worktree add` branches from
  `origin/<default>` (resolved via `origin/HEAD`), ensuring feature branches
  start from the remote baseline rather than a local dirty state or arbitrary
  `HEAD`.

### Dependency Management Across Worktrees

Each Git worktree maintains an independent working directory, while modern
package managers optimize dependency caching across worktrees:

- **`pnpm`**: Uses a central content-addressable store
  (`~/.local/share/pnpm/store`). Running `pnpm install` in a new worktree
  hard-links dependencies from the central store without duplicating files or
  re-downloading packages.
- **Deno**: Uses the global `DENO_DIR` module cache (`~/.cache/deno` or
  `%LOCALAPPDATA%\deno`), sharing cached dependencies across all worktrees
  zero-copy.
- **npm / yarn**: Running `npm install` or `yarn install` inside a worktree
  installs dependencies for that worktree, fetching packages from the shared
  user HTTP cache.

### Troubleshooting & Common Pitfalls

- **`PATH_BLOCKED` or `INVALID` during `init`**: An existing directory or file
  occupies the expected repository path but is not a valid Git repository.
  `wspace init` fails closed without touching or overwriting the path. Remove or
  relocate the blocking path manually.
- **`SKIP_FEATURE` / `FEATURE_CLEAN`**: Indicates that `repos/<repo>` is checked
  out on a feature branch instead of the default branch. `wspace update` skips
  updating feature branches to protect user work.
- **Symlink rejection in `env sync`**: For security, `wspace env sync` will
  refuse to overwrite any destination path that is a symbolic link.
- **Dirty linked worktrees**: `wspace check` inspects both primary checkouts and
  linked feature worktrees. If any linked worktree has uncommitted changes,
  `wspace check` returns a non-zero exit code (`1`).

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
