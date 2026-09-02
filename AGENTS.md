# AGENTS.md

## Repository

`wazootech/workspace-cli` — the `wspace` binary. A thin, git-native CLI for
managing the Wazoo multi-repo workspace without submodules. See `README.md`.

## Parent workspace rules

This repo lives inside `repos/workspace-cli/` in a multi-repo workspace. The
workspace root's `AGENTS.md` defines hard boundaries that apply here:

Feature work should use raw Git worktrees when isolation is needed; this CLI
does not manage their location or lifecycle.

## Conventions

- Deno 2, TypeScript, strict mode. `@std` packages are the only allowed
  dependencies (runtime included); nothing outside `@std`.
- TypeScript source in `src/`, tests in `tests/`. `tests/integration_test.ts`
  exercises real local git repositories under a temp dir.
- Machine-readable git: use `--porcelain` output formats and `GitRunner` (an
  interface over `git`/`gh`/filesystem) so logic stays testable.
- Commands never mutate user work: update fast-forwards clean default branches
  only and never resets, rebases, stashes, or rewrites history.
- `wspace init` scaffolds a new workspace manifest and standard directories in
  an empty location; `wspace install` clones missing repositories from the
  manifest; `wspace add`/`remove` curate manifest entries surgically (comments
  preserved; remove never deletes checkouts); `wspace check` exits 0 on clean, 1
  on any non-clean repo.

## Verification

```sh
deno task ci
```
