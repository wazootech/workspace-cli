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
- **Conservative mutation.** Commands that write or move state (`update`,
  `install`, `add`, `remove`) refuse to touch dirty repositories, feature
  branches, missing repos, and unmanaged checkouts. `update` only fetches and
  fast-forwards clean default branches; it never resets, rebases, stashes, or
  rewrites history. When the workspace root directory is itself a git checkout,
  it is treated like any other repository under the same policy (`update`
  fast-forwards a clean root; `check` reports it as `(workspace root)`).
- **Machine-readable output.** `check --json` emits structured results for
  tools; plain output is for humans.
- **Exit code contract.** `wspace check` exits `0` when the workspace is clean
  and `1` when any repository is dirty, diverged, missing, or not in sync.

## Manifest schema

Schema version 4 keeps ordinary repositories and workspace repositories in
separate arrays, `repositories[]` and `workspaces[]`, with the same two entry
forms in either:

1. **Shorthand** `"repo"`, `"owner/repo"`, or `{ "name", "owner" }` — expands
   against the manifest's `host` (default `github.com`) and top-level `owner` to
   `https://<host>/<owner>/<name>.git`.
2. **Object** `{ "name", "url" }` — a plain repository for any Git host. `url`
   and `owner` are mutually exclusive on object entries.

A `workspaces[]` entry must be a Git repository containing a valid
`workspace.json` child manifest. Workspace checkouts live under
`workspacesDirectory` when set, otherwise under `repositoriesDirectory`; the
child manifest's repositories resolve against that child's own `repos/`
directory. Use `wspace add --as-workspace` to write a `workspaces[]` entry.

Unknown keys are ignored by the loader (v3 leftovers such as entry-level `path`,
`groups`, `localFiles`, and `manifest` fall through silently). The only removed
key that errors is `vaultDirectory`.

## Local names

A repository checks out at `<repositoriesDirectory>/<name>`, where `name` is the
post-expansion label: ownership lives in URLs, never in paths. Names reject
slashes, backslashes, and traversal. Within one manifest, names must be unique
across `repositories[]` and `workspaces[]`, even when the directories differ;
across workspaces the same name is allowed because each checks out under its own
directory. The only conflict is when two entries resolve to the same checkout
path. To use a different local label than the shorthand name, write the explicit
form with your chosen `name` plus a full `url`. Child manifests are
self-contained: their own `host` and `owner` apply, and they re-root their own
directory defaults.

## Commands

| Command                                                                                                       | Purpose                                                                                                                                                                                                                                                                                              |
| :------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wspace check [--json] [--workspace <name>]`                                                                  | Read-only baseline check. Reports `CLEAN`, `DIRTY`, `FEATURE_CLEAN`, `DIVERGED`, `UNKNOWN`, `MISSING`, `UNMANAGED` states. A git workspace root is reported first as `(workspace root)`; untracked files there never count as dirty. Omitted when scoped with `--workspace`.                         |
| `wspace init [--host <host>] [--owner <owner>] [<repo...>]`                                                   | One-time scaffold for an empty directory: writes a fresh `workspace.json` (schema v4) with optional host/owner and seeded shorthand entries, and creates the standard `repos/` directory. Fails closed if any manifest already exists.                                                               |
| `wspace install [<repo...>] [--json] [--workspace <name>] [--dry-run]`                                        | Clone missing repos, converging in one invocation: each pass re-resolves the tree, so newly detected sub-workspaces bootstrap without reruns. Scoped targets stay single-pass. Fresh clones lack gitignored files and repo setup. `i` is an alias.                                                   |
| `wspace add [<name>] [--url <url>] [--name <n>] [--as-workspace] [--create] [--visibility <public\|private>]` | Append a manifest entry: shorthand string, or object via `--url`. `--as-workspace` places the entry in the `workspaces[]` array. Surgical edit (comments preserved). GitHub shorthands probed with `gh`; `--create` makes a missing repo first (default private). Never clones; run `install` after. |
| `wspace remove <repo>`                                                                                        | Delete the manifest entry by effective name. Surgical edit; local checkouts are never deleted.                                                                                                                                                                                                       |
| `wspace path <query> [--json]`                                                                                | Fuzzy-find a workspace directory (repo or sub-workspace). Use in command substitution: `cd "$(wspace path workspace-cli)"`.                                                                                                                                                                          |
| `wspace update [--json] [--workspace <name>] [--dry-run]`                                                     | Fetch remotes and fast-forward only clean default branches, including the workspace root's own checkout when it is a git repository (reported first; untracked workspace content never marks it dirty). Omitted when scoped with `--workspace`.                                                      |
| `wspace workspaces [--json]`                                                                                  | List discovered sub-workspaces with repo counts.                                                                                                                                                                                                                                                     |
| `wspace validate`                                                                                             | Validate the manifest without touching any repository.                                                                                                                                                                                                                                               |

All paths resolve relative to the directory containing the manifest. When
running raw git, use the absolute `"$PWD/..."` form (e.g.
`git -C repos/<repo> worktree add "$PWD/worktrees/<repo>/<feature>" -b <feature>`)
so paths anchor to the workspace root regardless of the current directory.

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

If `wspace check` exits `1` — or reports any state other than `CLEAN` or
`FEATURE_CLEAN` — halt and request user resolution before applying multi-repo
edits.

A `FEATURE_CLEAN` checkout can be fully landed upstream (squash merges detach
branch commits); run the root AGENTS.md **Upstream verification** tip diff
before treating its content as stranded.

## Common pitfalls

- **`PATH_BLOCKED` or `INVALID` during `install`**: An existing path occupies
  the expected repository location but is not a Git repository — including a
  destination that is a symbolic link not pointing at a Git checkout.
  `wspace
  install` fails closed without touching it. Remove or relocate the
  blocking path manually.
