# ADR-0001: Git-native worktrees

- Status: accepted
- Date: 2026-08

## Context

Developing multiple features in parallel across a multi-repo workspace requires
a way to check out feature branches without stashing or switching branches in
the canonical `repos/` checkouts. Submodules add overhead and indirection.

## Decision

Use `git worktree` with a shared, conventional layout under the workspace root:

```text
worktrees/
  memsdk/
    add-batch-ops/
  worlds-api/
    docker-healthcheck/
```

Each worktree directory is a full working tree linked to the source repository.
Branch names and worktree directory names share a short kebab-case slug.

## Consequences

- Worktrees are cheap to create, list (`git worktree list --porcelain`), and
  remove.
- Tool-specific directories (Codex/OpenCode worktree dirs) are valid secondary
  locations and are never touched by workspace scripts.
- A worktree that checks out a repo's default branch leaves the `repos/`
  checkout on a feature branch, which `workspace:check` reports as
  `FEATURE_CLEAN` (informational, not an error) and `workspace:update` skips.
