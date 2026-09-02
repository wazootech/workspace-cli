# ADR-0005: Drop secrets and worktrees management

- Status: accepted
- Date: 2026-09
- Supersedes: ADR-0001, ADR-0003 (see below)

## Context

The `wspace` toolchain took responsibility for two concerns beyond its core
purpose of managing the workspace manifest and `repos/` directory:

- **Secrets management** — the central `secrets/<repo>/` vault and
  `wspace env sync` flows.
- **Worktree management** — `wspace worktree add/list/remove` and git-native
  worktree discovery.

Both added CLI surface (commands, flags, config keys, test coverage) and
overlapped with tools better suited for the job (`git worktree` directly, or a
dedicated secrets manager). Tracked in
[issue #123](https://github.com/wazootech/workspace-cli/issues/123), implemented
in PR #132.

## Decision

The CLI is reduced to its core: workspace config (`workspace.json` — manifest,
schema, validation) and the `repos/` directory (clone, sync, update).

1. **Remove `wspace env sync`** and the `secrets/<repo>/` vault flows from the
   CLI. Local credentials are handled by a manual workflow or a dedicated
   secrets tool.
2. **Remove `wspace worktree add|list|remove`** and the `--stale` flag.
   Worktrees are managed with raw `git worktree`. The on-disk convention
   (`worktrees/<repo>/<feature>`) is no longer imposed by wspace; each
   workspace's `AGENTS.md` owns its worktree-location convention.
3. **`wspace init` scaffolds only `repos/`** — it no longer creates `worktrees/`
   or `secrets/`.
4. **Remove the `worktreesDirectory` and `secretsDirectory` manifest keys** from
   the schema, types, and normalization (present values are ignored; only the
   legacy `vaultDirectory` key is rejected explicitly).
5. **`wspace check` stops reporting worktree state** — `isWorktree` rows and
   stale/worktree-missing warnings are removed.
6. **Keep the read-only worktree guard in `wspace update`:** update still
   refuses to fast-forward a default branch that is checked out in a worktree,
   via a single `git worktree list --porcelain` call per repo. This protects the
   conservative-update policy (ADR-0002) and is safety, not management.
7. **`wspace path` no longer special-cases `worktrees/` or `secrets/`** — only
   `repos/` is depth-limited (depth 1); every other top-level directory is
   walked generically at depth 1 like any ordinary directory.

## Consequences

- Smaller, more focused CLI surface: fewer commands, flags, config keys, tests,
  and docs to maintain.
- Worktree users switch to raw `git worktree`; per-project `AGENTS.md` files
  (not wspace) define where worktrees live relative to their base repo.
- `wspace env sync` consumers need the manual fallback or a dedicated secrets
  tool (see [`docs/migration-guide.md`](../migration-guide.md)).
- **Breaking change** (`0.6.0`): the `worktree` and `env` commands, the
  worktree/env public exports in `src/mod.ts`, and the
  `worktreesDirectory`/`secretsDirectory` manifest keys are removed. (`0.5.0`
  was released before this change landed.)
- ADR-0001 (git-native worktrees) and ADR-0003 (worktree baseline and staleness)
  are superseded to the extent that wspace no longer manages worktrees; the
  underlying `git worktree` pattern they describe remains valid and is exercised
  directly by users.
