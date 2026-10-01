# ADR-0006: `wspace sweep` removes merged worktrees, without managing them

- Status: accepted
- Date: 2026-09
- Amends: ADR-0005
- Related: ADR-0002 (conservative update policy), issue
  [#153](https://github.com/wazootech/workspace-cli/issues/153)

## Context

ADR-0005 removed `wspace worktree add|list|remove` and the `worktreesDirectory`
key, on the grounds that the CLI should not own worktree _management_: worktrees
are managed with raw `git worktree`, and each workspace's `AGENTS.md` owns where
they live.

That left a real gap. Reclaiming a workspace after a merge is a seven-step
ritual repeated per repository:

1. merge the PR,
2. `git worktree remove worktrees/<repo>/<feature>` — which on Windows usually
   fails with `Filename too long`,
3. hand-purge the leftover directory,
4. `git worktree prune`,
5. `git branch -D <feature>`,
6. `git push origin --delete <feature>`,
7. `git merge --ff-only origin/main` in the canonical checkout.

Every one of those steps is a chance to delete the wrong thing, and the
long-path failure in step 2 is not something `git worktree remove` can recover
from on its own. Repeating this by hand across ~40 repositories is how stale
worktrees accumulate.

A sweep appears to violate ADR-0005. It does not, for one reason: **ADR-0005
point 6 deliberately kept a read-only `git worktree list --porcelain` guard in
`wspace update`**, justified as _"safety, not management."_ ADR-0005's concern
was CLI ownership of worktree _creation and placement_, not awareness of them. A
sweep lives in exactly that carve-out.

## Decision

Add `wspace sweep`: remove every linked worktree in the workspace whose branch
is already merged.

1. **Discovery comes from git, not from paths.** For each managed repository
   (and the workspace root, which is not a manifest entry), run
   `git worktree list --porcelain` and treat every entry after the first — the
   main worktree — as a candidate. No directory is globbed and no location
   convention is imposed or assumed. Branch names are read from git, never
   inferred from the worktree leaf name, which routinely differs
   (`world-id-hard-cutover`, `feat/frontmatter-fields`).

2. **A real git checkout is required before any git command runs.** Without this
   guard, a non-repo directory in the repositories tree (e.g. a
   `repos/worktrees/` directory) makes `git -C <dir> worktree list` walk up and
   report an _ancestor_ repository's worktrees, leaking root state into a child
   repository's sweep. This mirrors the `.git` guard `collectStatus` uses.

3. **A merge must be proven, offline, before anything is deleted.** The proof
   ladder is cheapest-first: tree equality, then an empty diff, then zero
   commits ahead of the baseline. These tiers are what authorise cleanup of
   rebase and squash merges, whose commits have different SHAs than anything on
   the default branch and which `git branch -d` refuses to delete.

4. **The baseline is `origin/<default>`** when that ref exists, falling back to
   the local default branch. This is load-bearing: immediately after a merge the
   canonical checkout is usually still _behind_ `origin/<default>`, so proving
   against the local ref would refuse cleanup in exactly the case the command
   exists for.

5. **Two gates refuse to act**, each overridable with `--force`: the merge proof
   (gate 1) and a clean `git status --porcelain` in the worktree, untracked
   files included (gate 2). The default branch and the main worktree are never
   targets at all, and detached-HEAD worktrees are skipped because they have no
   branch to prove.

6. **`--delete-remote` is opt-in.** A sweep must never silently delete a remote
   ref; local cleanup alone reports `SKIPPED_REMOTE`.

7. **Refusals are reported, not fatal.** The exit code is non-zero only when a
   mutation actually broke (`FAILED`), matching `update`'s conservative-update
   tone from ADR-0002 rather than `check`'s stricter contract. `--strict`
   promotes refusals for use in scripts.

8. **`--dry-run` proves but does not mutate or reach the network.** Unlike a
   naive preview, it still runs the proof ladder, so it surfaces the refusal a
   real run would produce rather than exiting 0 with "proof unavailable".

9. **When `git worktree remove` fails, the directory is purged by escalating
   strategies** (`Deno.remove` recursive, then a Windows verbatim `\\?\` path,
   then an empty-source `robocopy /MIR` and a verbatim `rmdir`; `rm -rf` on
   POSIX) and the worktree is pruned. The strategy that worked is reported.
   Mutations happen in order: remove, prune, `branch -D`, optional remote
   delete.

## Consequences

- Reclaiming a merged branch becomes one command instead of seven, workspace
  wide, and is safe to run unattended: it acts only on proven merges and clean
  trees, and degrades to a reported refusal otherwise.
- The CLI still does not create, place, or name worktrees. A workspace remains
  free to keep them anywhere, and ADR-0005's removal of
  `worktree add|list|remove` and the `worktreesDirectory` key stands.
- The sweep surface is read-mostly discovery plus a narrow, well-gated delete.
  This is the "safety, not management" line ADR-0005 drew, now applied to
  removal instead of only to `update`'s fast-forward guard.
- `wspace sweep` does not fast-forward the canonical checkout. That stays the
  job of `wspace update`, which already does it under ADR-0002, so the two
  commands compose instead of overlapping: `wspace sweep && wspace update`.
- Merged branches that never had a worktree are out of scope; the command acts
  on linked worktrees, which is where the worktree-isolation pattern leaves its
  residue.
- The remote-proof tier (`gh pr view <branch> --json state`) is deliberately
  **not** implemented. The offline tiers cover the rebase/squash cases that
  plain `git branch -d` mishandles, and keeping the common path free of network
  calls keeps a workspace-wide sweep fast. Revisit if proof coverage proves
  insufficient in practice.
