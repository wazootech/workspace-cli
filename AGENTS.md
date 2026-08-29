# AGENTS.md

## Repository

`wazootech/workspace-cli` — the `works` binary. A thin, git-native CLI for
managing the Wazoo multi-repo workspace without submodules. See `README.md`.

## Parent workspace rules

This repo lives inside `repos/workspace-cli/` in a multi-repo workspace. The
workspace root's `AGENTS.md` defines hard boundaries that apply here:

**Worktree isolation (hard boundary):** All feature work must happen in a
worktree (`worktrees/<repo>/<feature>`). Never create branches or commit
directly inside `repos/<repo>`. If your cwd is inside `repos/<repo>/`, stop and
create a worktree first:

```sh
cd <workspace-root>
works worktree add workspace-cli <feature-slug>
cd worktrees/workspace-cli/<feature-slug>
```

This applies to all skills and agents, not just the `works` pipeline. Code
changes from `/review`, `/investigate`, `/qa`, or any other skill must also go
through a worktree.

See `../AGENTS.md` (workspace root) for the full rules including workspace root
resolution, worktree path construction, and cleanup procedures.

## Conventions

- Deno 2, TypeScript, strict mode. `@std` packages are the only allowed
  dependencies (runtime included); nothing outside `@std`.
- TypeScript source in `src/`, tests in `tests/`. `tests/integration_test.ts`
  exercises real local git repositories under a temp dir.
- Machine-readable git: use `--porcelain` output formats and `GitRunner` (an
  interface over `git`/`gh`/filesystem) so logic stays testable.
- Commands never mutate user work: update fast-forwards clean default branches
  only; worktree and env operations refuse dirty or feature-branch checkouts.
- `works init` scaffolds a new workspace manifest and standard directories in an
  empty location; `works install` clones missing repositories from the manifest;
  `works add`/`remove` curate manifest entries surgically (comments preserved;
  remove never deletes checkouts); `works check` exits 0 on clean, 1 on any
  non-clean repo.

## Verification

```sh
deno task ci
```
