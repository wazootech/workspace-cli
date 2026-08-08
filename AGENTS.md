# AGENTS.md

## Repository

`wazootech/workspace-cli` — the `wspace` binary. A thin, git-native CLI for
managing the Wazoo multi-repo workspace without submodules. See `README.md`.

## Conventions

- Deno 2, TypeScript, strict mode. No external runtime dependencies; `@std`
  packages only for tests.
- TypeScript source in `src/`, tests in `tests/`. `tests/integration_test.ts`
  exercises real local git repositories under a temp dir.
- Machine-readable git: use `--porcelain` output formats and `GitRunner` (an
  interface over `git`/`gh`/filesystem) so logic stays testable.
- Commands never mutate user work: update fast-forwards clean default branches
  only; worktree and env operations refuse dirty or feature-branch checkouts.
- `wspace init` (alias `wspace sync`) clones missing repositories from the
  manifest; `wspace check` exits 0 on clean, 1 on any non-clean repo.

## Verification

```sh
deno task ci
```
