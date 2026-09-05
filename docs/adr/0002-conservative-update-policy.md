# ADR-0002: Conservative update policy

- Status: accepted
- Date: 2026-08

## Context

The workspace update command must refresh clean default branches from their
upstreams without ever destroying or rewriting user work. Automation should make
safe, predictable progress and clearly report what it skipped and why.

## Decision

`wspace update` applies this policy, per repository:

1. Fetch the remote.
2. Compute the state of the current branch.
3. Skip the repository (reporting the reason) unless it is clean, on the default
   branch, and has an upstream.
4. Fast-forward only when the branch is strictly behind its upstream
   (`git
   merge --ff-only`). Report `CURRENT` when already in sync.
5. Never reset, rebase, stash, or force. Never touch dirty repositories, feature
   branches, missing repos, repos without upstreams, or branches that are ahead
   or diverged.

The workspace root's own checkout (the directory hosting the manifest) is
subject to the same policy when it is a git repository: `update` fast-forwards a
clean root on its default branch, and `check` reports it as `(workspace root)`
with the same `CLEAN`/`DIRTY`/`FEATURE_CLEAN`/`DIVERGED` semantics. The root's
dirty probe ignores untracked files, because the `repos/` and `worktrees/`
directories it materializes are the expected contents of a workspace checkout,
not user work. Scoped runs (`--workspace <name>`) leave the root out of both
`update` and `check`.

## Consequences

- Updates are always safe to run unattended: they make progress when possible
  and degrade to a no-op with a reason otherwise.
- The rule is symmetric with `workspace:check`: anything `check` would flag is
  something `update` refuses to touch.
- CI and handoff workflows can rely on the command never rewinding or deleting
  local state.
