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
  `host` key. `env`) refuse dirty repositories, feature branches, missing repos,
  and unmanaged checkouts. `update` only fetches and fast-forwards clean default
  branches; it never resets, rebases, stashes, or rewrites history. When the
  workspace root directory is itself a git checkout, it is treated like any
  other repository under the same policy (`update` fast-forwards a clean root;
  `check` reports it as `(workspace root)`).
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
`localFiles`, and `manifest`. The removed management keys `vaultDirectory`,
`worktreesDirectory`, and `secretsDirectory` are rejected.

## Local names

A repository checks out at `<repositoriesDirectory>/<name>`, where `name` is the
post-expansion label: ownership lives in URLs, never in paths. Names reject
slashes, backslashes, and traversal; duplicates - within a manifest or across
the composed tree - are errors. To use a different local label than the
shorthand name, write the explicit form with your chosen `name` plus a full
`url`. Child manifests are self-contained: their own `host` and `owner` apply.

Recursion conventions: child manifests re-root their own directory defaults.

## Commands

| Command                                                                                      | Purpose                                                                                                                                                                                                                               |
| :------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wspace check`                                                                               | Read-only baseline check. Reports `CLEAN`, `DIRTY`, `FEATURE_CLEAN`, `DIVERGED`, `UNKNOWN`, `MISSING`, `UNMANAGED` states. A git workspace root is reported first as `(workspace root)`.                                              |
| `wspace check --json`                                                                        | Structured per-repo state for tools.                                                                                                                                                                                                  |
| `wspace install [<repo...>]`                                                                 | Clone missing repos, converging in one invocation: each pass re-resolves the tree, so newly detected sub-workspaces bootstrap without reruns. Scoped targets stay single-pass. Fresh clones lack gitignored files and repo setup.     |
| `wspace add [<name>] [--url <url>] [--name <n>] [--create] [--visibility <public\|private>]` | Append a manifest entry: shorthand string, or object via `--url`. Surgical edit (comments preserved). GitHub shorthands probed with `gh`; `--create` makes a missing repo first (default private). Never clones; run `install` after. |
| `wspace remove <repo>`                                                                       | Delete the manifest entry by effective name. Surgical edit; local checkouts are never deleted.                                                                                                                                        |
| `wspace update`                                                                              | Fetch remotes and fast-forward only clean default branches, including the workspace root's own checkout when it is a git repository.                                                                                                  |
| `wspace validate`                                                                            | Validate the manifest without touching any repository.                                                                                                                                                                                |

`origin/HEAD`) using `--no-track`, preventing forks from dirty local `HEAD`
references.

- **Path rule**: When running raw git, use the absolute `"$PWD/..."` form.
  `git -C repos/<repo>` changes Git's working directory to the repo root, so a
  instead of the workspace root. `$PWD` is the workspace root.

  ```sh
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

or returns any state other than `CLEAN` or `FEATURE_CLEAN`, halt or request user
resolution before applying multi-repo edits.

A `FEATURE_CLEAN` checkout can be fully landed upstream (squash merges detach
branch commits); run the root AGENTS.md **Upstream verification** tip diff
before treating its content as stranded.

## Common pitfalls

- **`PATH_BLOCKED` or `INVALID` during `install`**: An existing path occupies
  the expected repository location but is not a Git repository. `wspace install`
  fails closed without touching it. Remove or relocate the blocking path
  manually. any destination path that is a symbolic link.
