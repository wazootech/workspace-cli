# wspace command reference

The `wspace` CLI manages a multi-repo Wazoo workspace without Git submodules. It
keeps the working rules in one place and enforces them from the terminal.

Run any command from anywhere inside the workspace. The CLI auto-detects the
manifest by walking up from the current directory (like
`git rev-parse --show-toplevel`). Discovery checks the base name `workspace`
against the extension `.json`. Pass `--manifest <path>` to override
auto-detection.

## Design principles

- **Thin over custom.** Prefer plain `git` porcelain/plumbing and well-known
  directory conventions over bespoke state files.
- **Provider-agnostic.** Manifest URLs are passed directly to `git clone`; any
  Git host works (GitHub, GitLab, Bitbucket, SourceHut, Gitea, SSH remotes).
  Shorthand expansion defaults to `github.com` and is retargetable via the
  `host` key.
- **Conservative mutation.** Commands that write state (`update`, `worktree`,
  `env`) refuse dirty repositories, feature branches, missing repos, and
  unmanaged checkouts. `update` only fetches and fast-forwards clean default
  branches; it never resets, rebases, stashes, or rewrites history.
- **Machine-readable output.** `check --json` emits structured results for
  tools; plain output is for humans.
- **Exit code contract.** `wspace check` exits `0` when the workspace is clean
  and `1` when any repository is dirty, diverged, missing, or not in sync.

## Manifest schema

Schema version 4 keeps one `repositories[]` array with exactly two entry forms:

1. **Shorthand** `"repo"`, `"owner/repo"`, or `{ "name", "owner" }` — expands
   against the manifest's `host` (default `github.com`) and top-level/default
   `owner` to `https://<host>/<owner>/<name>.git`.
2. **Object** `{ "name", "url" }` — a plain repository for any Git host. `url`
   and `owner` are mutually exclusive on object entries.

Legacy keys removed in v4 produce migration errors: `workspaces[]` (composition
is now automatic through detection), entry fields `path`, `groups`,
`localFiles`, and `manifest`, and `vaultDirectory` (renamed to
`secretsDirectory`).

## Local names

A repository checks out at `<repositoriesDirectory>/<name>`, where `name` is the
post-expansion label: ownership lives in URLs, never in paths. Names reject
slashes, backslashes, and traversal; duplicates - within a manifest or across
the composed tree - are errors. To use a different local label than the
shorthand name, write the explicit form with your chosen `name` plus a full
`url`. Child manifests are self-contained: their own `host` and `owner` apply.

Recursion conventions: child manifests re-root their own directory defaults;
worktrees always land under the root workspace's `worktrees/`; `env sync` always
reads the root `secrets/<repoName>/`.

## Commands

| Command                                                                                      | Purpose                                                                                                                                                                                                                               |
| :------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wspace check`                                                                               | Read-only baseline check. Reports `CLEAN`, `DIRTY`, `FEATURE_CLEAN`, `DIVERGED`, `UNKNOWN`, `MISSING`, `UNMANAGED` states.                                                                                                            |
| `wspace check --json`                                                                        | Structured per-repo state for tools.                                                                                                                                                                                                  |
| `wspace init [--host <host>] [--owner <owner>] [<repo...>]`                                  | One-time scaffold for an empty directory: writes `workspace.json` (schema v4) with optional host/owner and seeded shorthand entries, and creates `repos/`, `worktrees/`, `secrets/`. Fails closed if any manifest already exists.     |
| `wspace install [<repo...>]`                                                                 | Clone missing repos, converging in one invocation: each pass re-resolves the tree, so newly detected sub-workspaces bootstrap without reruns. Scoped targets stay single-pass. Fresh clones lack gitignored files and repo setup.     |
| `wspace add [<name>] [--url <url>] [--name <n>] [--create] [--visibility <public\|private>]` | Append a manifest entry: shorthand string, or object via `--url`. Surgical edit (comments preserved). GitHub shorthands probed with `gh`; `--create` makes a missing repo first (default private). Never clones; run `install` after. |
| `wspace remove <repo>`                                                                       | Delete the manifest entry by effective name. Surgical edit; local checkouts are never deleted.                                                                                                                                        |
| `wspace update`                                                                              | Fetch remotes and fast-forward only clean default branches.                                                                                                                                                                           |
| `wspace worktree add <repo> <feature> [<commit-ish>]`                                        | Create a git worktree under `worktrees/<repo>/<feature>/`, branching from `origin/<default>` or an explicit `<commit-ish>`.                                                                                                           |
| `wspace worktree list [--stale] [--json]`                                                    | List worktrees across all repos. `--stale` filters to worktrees whose branch is fully merged (safe removal candidates).                                                                                                               |
| `wspace worktree remove <repo> <feature>`                                                    | Remove a worktree, then prune and tidy the empty `worktrees/<repo>/` directory.                                                                                                                                                       |
| `wspace env sync [--dry-run]`                                                                | Copy local environment files from a gitignored `secrets/` directory into checkouts and worktrees.                                                                                                                                     |
| `wspace validate`                                                                            | Validate the manifest without touching any repository.                                                                                                                                                                                |

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

- **`PATH_BLOCKED` or `INVALID` during `install`**: An existing path occupies
  the expected repository location but is not a Git repository. `wspace install`
  fails closed without touching it. Remove or relocate the blocking path
  manually.
- **Symlink rejection in `env sync`**: `wspace env sync` refuses to overwrite
  any destination path that is a symbolic link.
- **Dirty linked worktrees**: `wspace check` inspects primary checkouts and
  linked feature worktrees. A dirty linked worktree returns exit code `1`.
