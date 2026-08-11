---
name: wspace
description: Manage multi-repo Wazoo workspaces, feature worktrees, conservative default-branch updates, and secret sync using the git-native wspace CLI. Use when managing multi-repo workflows, creating or removing feature worktrees, checking workspace baseline health, syncing environment secrets, or running wspace commands.
---

# `wspace` Workspace Skill

Use this skill to orchestrate multi-repo development, isolate tasks in Git
worktrees, refresh default branch baselines safely, and synchronize environment
secrets using `wspace` (the Wazoo Workspace CLI).

## Quick Start

Execute all workspace commands from the workspace root (where `repos.json`
resides):

```sh
# 1. Inspect workspace baseline health
wspace check

# 2. Fast-forward clean default branches safely
wspace update

# 3. Create isolated feature worktree anchored to origin/<default>
wspace worktree add <repo> <feature>
# (Or using raw git): git -C repos/<repo> worktree add "$PWD/worktrees/<repo>/<feature>" -b <feature>

# 4. Propagate local secrets to checkouts and worktrees
wspace env sync

# 5. Push branch & open PR (from inside worktrees/<repo>/<feature>)
git push -u origin <feature>
gh pr create

# 6. List fully merged stale worktrees & clean up
wspace worktree list --stale
wspace worktree remove <repo> <feature>
```

## Worktree Lifecycle & Workflows

### Workflow 1: Feature Worktree Creation & Isolation

When starting work on a feature, bug fix, or agent task:

1. **Baseline Health Check**: Run `wspace check`. Verify that the repository is
   clean or on a default branch.
2. **Refresh Upstreams**: Run `wspace update` to fetch remotes and fast-forward
   clean default branches (`merge --ff-only`).
3. **Provision Worktree**:
   - Primary CLI command: `wspace worktree add <repo> <feature>`
   - Direct Git command:
     `git -C repos/<repo> worktree add "$PWD/worktrees/<repo>/<feature>" -b <feature>`
   - _Baseline Rule_: `wspace worktree add` automatically branches from
     `origin/<default>` (via `origin/HEAD`) using `--no-track`, preventing
     accidental forks from dirty local `HEAD`s.
   - _Path Rule_: Always use `$PWD` when running `git -C repos/<repo>` so
     worktrees resolve to `worktrees/<repo>/<feature>` at the workspace root
     rather than nested under `repos/<repo>/`.
4. **Sync Secrets**: Run `wspace env sync` (or `--dry-run` to preview) to copy
   secrets from `secrets/<repo>/` into the new worktree.
5. **Develop & Commit**: Perform changes strictly inside
   `worktrees/<repo>/<feature>/`. Keep `repos/<repo>/` clean.

### Workflow 2: Push, PR & Worktree Cleanup

1. **Push & Create PR**: Inside `worktrees/<repo>/<feature>/`, run:
   ```sh
   git push -u origin <feature>
   # Note: Clear dummy GITHUB_TOKEN if subshell causes 401: env GITHUB_TOKEN="" gh pr create
   gh pr create
   ```
2. **Identify Stale Worktrees**: After PR merge, run
   `wspace worktree list --stale`.
   - _Staleness Criteria_: Identifies worktrees whose branch has no unique
     commits beyond `origin/<default>` (fully merged) or whose branch ref is
     deleted.
3. **Teardown Worktree**: Run `wspace worktree remove <repo> <feature>`.
   - _Note_: Removes the worktree, prunes stale git references, and cleans up
     empty parent directories (`worktrees/<repo>/`).

### Workflow 3: Machine Inspection for Agents

When an AI agent needs to verify environment integrity before cross-repo edits:

- Call `wspace check --json` to receive structured state (`CLEAN`, `DIRTY`,
  `FEATURE_CLEAN`, `DIVERGED`, `MISSING`, `UNMANAGED`).
- If any repository returns error states (`DIRTY`, `DIVERGED`, `MISSING`), halt
  or request user resolution before modifying code.

## Guiding Principles

- **Root Anchor**: Workspace root is the single source of truth; all paths
  resolve relative to the directory containing `repos.json`.
- **Conservative Mutation**: `wspace update` never resets, rebases, stashes, or
  rewrites history. It skips dirty or feature branches.
- **Central Secret Vault**: Never write `.env` files directly in `repos/` or
  `worktrees/`. Always edit `secrets/<repo>/` and run `wspace env sync`.
