# Migration guide: from wspace-managed worktrees and secrets

`wspace` `0.6.0` removes worktree and secrets management from the CLI
([ADR-0005](adr/0005-drop-secrets-and-worktrees-management.md),
[issue #123](https://github.com/wazootech/workspace-cli/issues/123)). This guide
maps the old commands to their replacements. No migration tooling is provided —
the equivalents are plain `git` and manual file operations.

All recipes below assume a multi-repo workspace whose root contains the manifest
(`workspace.json`) and `repos/`.

## Worktrees

### Add a worktree

Before:

```sh
wspace worktree add <repo> <feature> [<commit-ish>]
```

After — run from your workspace root:

```sh
git -C repos/<repo> worktree add worktrees/<repo>/<feature> -b <feature> [<commit-ish>]
```

Notes:

- The worktree path is anchored to your **workspace root**. Where exactly it
  lives is now each workspace's own convention: check the workspace's
  `AGENTS.md` (worktree location is no longer imposed by wspace).
- Never construct the path with `$PWD` from inside `repos/<repo>` — `$PWD`
  resolves to the child repo and `git worktree remove` will fail.
- To attach an existing branch instead of creating one, drop `-b <feature>`:
  `git -C repos/<repo> worktree add <path> <feature>`.

### List worktrees

Before:

```sh
wspace worktree list [--stale] [--json]
```

After:

```sh
git -C repos/<repo> worktree list          # human-readable
git -C repos/<repo> worktree list --porcelain   # machine-readable (JSON consumers parse this)
```

Stale (fully merged) candidate detection was provided by `--stale`; raw git
equivalents include `git -C repos/<repo> branch --merged origin/<default>` and
`git merge-base --is-ancestor` per worktree branch.

### Remove a worktree

Before:

```sh
wspace worktree remove <repo> <feature>
```

After:

```sh
git -C repos/<repo> worktree remove worktrees/<repo>/<feature>
git -C repos/<repo> worktree prune
```

`wspace` previously removed the now-empty `worktrees/<repo>/` parent directory
best-effort; do the same manually if you want the parent gone.

## Secrets / environment files

Before:

```sh
wspace env sync [--dry-run] [--json]
```

After: there is no built-in replacement. Either copy the vault file manually, or
use a dedicated secrets tool:

```sh
cp secrets/<repo>/.env repos/<repo>/.env
chmod 600 repos/<repo>/.env
```

The central `secrets/<repo>/` vault layout is a workspace convention, not a
wspace feature — keep it if your workspace wants it.

## Manifest keys

- `"secretsDirectory"` and `"worktreesDirectory"` are no longer part of the
  manifest schema. Workspaces that never set them are unaffected; remove any
  custom values from `workspace.json`. The legacy `"vaultDirectory"` key is
  rejected with a pointed error.

## Init scaffolding

- `wspace init` now creates only `repos/` (plus the manifest). It no longer
  scaffolds `worktrees/` or `secrets/`; create them only if your workspace's
  `AGENTS.md` calls for them.
