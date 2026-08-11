---
name: wspace
description: Manage multi-repo Wazoo workspaces, feature worktrees, conservative default-branch updates, and secret sync using wspace CLI. Use when managing multi-repo workflows, creating feature worktrees, checking baseline health, syncing secrets, or running wspace commands.
---

# `wspace` workspace skill

Orchestrate multi-repo development, isolate tasks in Git worktrees, refresh
default branch baselines safely, and synchronize environment secrets using
`wspace`.

## Quick start

Execute all workspace commands from the workspace root containing `repos.json`:

```sh
# Inspect workspace baseline health
wspace check

# Fast-forward clean default branches safely
wspace update

# Create isolated feature worktree anchored to origin/<default>
wspace worktree add <repo> <feature>
# (Or using raw git): git -C repos/<repo> worktree add "$PWD/worktrees/<repo>/<feature>" -b <feature>

# Propagate local secrets to checkouts and worktrees
wspace env sync

# Push branch and open PR from inside worktrees/<repo>/<feature>
git push -u origin <feature>
env GITHUB_TOKEN="" gh pr create

# List fully merged stale worktrees and clean up
wspace worktree list --stale
wspace worktree remove <repo> <feature>
```

## Worktree lifecycle and workflows

### Feature worktree creation and isolation

To start work on a feature, bug fix, or agent task:

1. **Baseline health check**: Run `wspace check` to verify the repository is
   clean or on a default branch.
2. **Refresh upstreams**: Run `wspace update` to fetch remotes and fast-forward
   clean default branches (`merge --ff-only`).
3. **Provision worktree**: Run `wspace worktree add <repo> <feature>` or
   `git -C repos/<repo> worktree add "$PWD/worktrees/<repo>/<feature>" -b <feature>`.
   - **Baseline rule**: `wspace worktree add` automatically branches from
     `origin/<default>` (via `origin/HEAD`) using `--no-track`, preventing
     accidental forks from dirty local `HEAD` references.
   - **Path rule**: Always use `$PWD` when running `git -C repos/<repo>` so
     worktrees resolve to `worktrees/<repo>/<feature>` at the workspace root
     rather than nested under `repos/<repo>/`.
4. **Sync secrets**: Run `wspace env sync` (or `--dry-run` to preview) to copy
   secrets from `secrets/<repo>/` into the new worktree.
5. **Develop and commit**: Perform changes strictly inside
   `worktrees/<repo>/<feature>/`. Keep `repos/<repo>/` clean.

### Push, PR, and worktree cleanup

1. **Push and create PR**: Inside `worktrees/<repo>/<feature>/`, run:
   ```sh
   git push -u origin <feature>
   env GITHUB_TOKEN="" gh pr create
   ```
2. **Identify stale worktrees**: After PR merge, run
   `wspace worktree list --stale`.
   - **Staleness criteria**: Identifies worktrees whose branch has no unique
     commits beyond `origin/<default>` (fully merged) or whose branch ref is
     deleted.
3. **Teardown worktree**: Run `wspace worktree remove <repo> <feature>`.
   - **Cleanup**: Removes the worktree, prunes stale git references, and cleans
     up empty parent directories (`worktrees/<repo>/`).

### Machine inspection for agents

To verify workspace integrity before cross-repo edits:

- Call `wspace check --json` to receive structured state per repo (`CLEAN`,
  `DIRTY`, `FEATURE_CLEAN`, `DIVERGED`, `UNKNOWN`, `MISSING`, `INVALID`,
  `WORKTREE_DIRTY`, `ERROR`).
- If `wspace check` exits with `1` or returns any state other than `CLEAN` or
  `FEATURE_CLEAN`, halt or request user resolution before applying multi-repo
  edits.

## Guiding principles

- **Root anchor**: The workspace root is the single source of truth; all paths
  resolve relative to the directory containing `repos.json`.
- **Conservative mutation**: `wspace update` never resets, rebases, stashes, or
  rewrites history. It skips dirty or feature branches.
- **Central secret vault**: Never write `.env` files directly in `repos/` or
  `worktrees/`. Always edit `secrets/<repo>/` and run `wspace env sync`.
