# ADR-0003: Explicit worktree baseline and merged-branch staleness

- Status: accepted
- Date: 2026-08

## Context

`wspace worktree add` created feature branches with
`git worktree add --track -b
<branch> <path>`, forking from the current HEAD of
the `repos/` checkout. When that checkout sat on a stale or unrelated branch,
features silently forked from the wrong baseline. `--track` was also a no-op:
the start point was a local branch, so git set up no upstream. Separately,
`wspace worktree list --stale` listed detached worktrees, conflating a detached
HEAD with a worktree that is safe to delete.

## Decision

1. `wspace worktree add <repo> <feature> [<commit-ish>]` branches from the
   default-branch baseline `origin/<default>` (resolved from `origin/HEAD`) by
   default, or from an explicit `<commit-ish>` when given. The git invocation is
   `git worktree add --no-track -b <feature> <path> <start-point>`: `--no-track`
   avoids wiring the new branch to track `origin/<default>`, which default
   `branch.autoSetupMerge` would do for a remote-tracking start point. Upstream
   is set later by `git push -u origin <feature>`. No fetch is performed;
   `wspace update` remains the refresh step, matching git's own behavior of
   branching from the last-fetched refs.
2. When a branch named `<feature>` already exists locally, `worktree add`
   attaches it (`git worktree add --no-track <path> <feature>`) with a warning,
   enabling resume of prior-session work.
3. `wspace worktree list --stale` lists linked worktrees whose branch has no
   commits beyond `origin/<default>` (fully merged or not yet diverged, tested
   with `git merge-base --is-ancestor`) or whose branch ref is missing. The main
   worktree, bare entries, and detached worktrees are excluded; detached
   worktrees remain visible in the unfiltered `list`. Each stale row carries a
   `reason` (`merged` | `branch-missing`).
4. After a successful `wspace worktree remove`, the now-empty
   `worktrees/<repo>/` parent directory is removed (best-effort).

## Consequences

- Feature branches always fork from the last-fetched remote baseline, even when
  the `repos/` checkout is on a feature branch or detached.
- The staleness test matches git's own "merged" notion (`git branch --merged`):
  a worktree whose branch has no unique commits is a safe deletion candidate,
  which includes a freshly created worktree that has not yet diverged.
- `--stale` becomes an actionable cleanup list rather than a proxy for detached
  HEADs.
- `worktree add` fails loudly when no default branch can be resolved and no
  explicit `<commit-ish>` is given, instead of silently forking from HEAD.
