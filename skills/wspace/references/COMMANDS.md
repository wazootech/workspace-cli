# wspace command reference

The `wspace` CLI manages a multi-repo Wazoo workspace without Git submodules. It
keeps the working rules in one place and enforces them from the terminal.

Run every command from the workspace root, the directory containing the manifest
(`repos.json`, `wspace.json`, or `workspace.json`).

## Design principles

- **Thin over custom.** Prefer plain `git` porcelain/plumbing and well-known
  directory conventions over bespoke state files.
- **Conservative mutation.** Commands that write state (`update`, `worktree`,
  `env`) refuse dirty repositories, feature branches, missing repos, and
  unmanaged checkouts. `update` only fetches and fast-forwards clean default
  branches; it never resets, rebases, stashes, or rewrites history.
- **Machine-readable output.** `check --json` emits structured results for
  tools; plain output is for humans.
- **Exit code contract.** `wspace check` exits `0` when the workspace is clean
  and `1` when any repository is dirty, diverged, missing, or not in sync.

## Commands

| Command                                               | Purpose                                                                                                                      |
| :---------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| `wspace check`                                        | Read-only baseline check. Reports `CLEAN`, `DIRTY`, `FEATURE_CLEAN`, `DIVERGED`, `UNKNOWN`, `MISSING`, `UNMANAGED` states.   |
| `wspace check --json`                                 | Structured per-repo state for tools.                                                                                         |
| `wspace init [<repo...>]`                             | Clone missing repositories from the manifest, or only a specified subset. Fresh clones lack gitignored files and repo setup. |
| `wspace sync`                                         | Alias for `wspace init`.                                                                                                     |
| `wspace update`                                       | Fetch remotes and fast-forward only clean default branches.                                                                  |
| `wspace worktree add <repo> <feature> [<commit-ish>]` | Create a git worktree under `worktrees/<repo>/<feature>/`, branching from `origin/<default>` or an explicit `<commit-ish>`.  |
| `wspace worktree list [--stale] [--json]`             | List worktrees across all repos. `--stale` filters to worktrees whose branch is fully merged (safe removal candidates).      |
| `wspace worktree remove <repo> <feature>`             | Remove a worktree, then prune and tidy the empty `worktrees/<repo>/` directory.                                              |
| `wspace env sync [--dry-run]`                         | Copy local environment files from a gitignored `secrets/` vault into checkouts and worktrees.                                |
| `wspace validate`                                     | Validate the manifest without touching any repository.                                                                       |

## Worktree creation rules

- **Baseline rule**: `wspace worktree add` branches from `origin/<default>` (via
  `origin/HEAD`) using `--no-track`, preventing forks from dirty local `HEAD`
  references.
- **Path rule**: When running raw git, use the absolute `"$PWD/..."` form.
  `git -C repos/<repo>` changes Git's working directory to the repo root, so a
  relative path would nest the worktree under `repos/<repo>/worktrees/...`
  instead of the workspace root. `$PWD` is the workspace root.

  ```sh
  git -C repos/<repo> worktree add "$PWD/worktrees/<repo>/<feature>" -b <feature>
  ```

## Check status values

`wspace check` classifies each repository:

| State           | Meaning                                                                                  |
| :-------------- | :--------------------------------------------------------------------------------------- |
| `CLEAN`         | On the default branch with no uncommitted changes.                                       |
| `DIRTY`         | Uncommitted changes in the checkout.                                                     |
| `FEATURE_CLEAN` | On a clean feature branch (not the default branch). Informational; `update` skips these. |
| `DIVERGED`      | Local default branch has diverged from `origin`.                                         |
| `UNKNOWN`       | State could not be determined.                                                           |
| `MISSING`       | Expected repository path is not a clone.                                                 |
| `UNMANAGED`     | Checkout present but not tracked by the manifest.                                        |

A `WORKTREE_DIRTY` or `ERROR` state can also appear. If `wspace check` exits `1`
or returns any state other than `CLEAN` or `FEATURE_CLEAN`, halt or request user
resolution before applying multi-repo edits.

A `FEATURE_CLEAN` checkout can be fully landed upstream (squash merges detach
branch commits); run the root AGENTS.md **Upstream verification** tip diff
before treating its content as stranded.

## Common pitfalls

- **`PATH_BLOCKED` or `INVALID` during `init`**: An existing path occupies the
  expected repository location but is not a Git repository. `wspace init` fails
  closed without touching it. Remove or relocate the blocking path manually.
- **Symlink rejection in `env sync`**: `wspace env sync` refuses to overwrite
  any destination path that is a symbolic link.
- **Dirty linked worktrees**: `wspace check` inspects primary checkouts and
  linked feature worktrees. A dirty linked worktree returns exit code `1`.
