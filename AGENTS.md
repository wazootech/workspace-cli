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

- Bun toolchain, TypeScript, strict mode ("Node-compatible code, Bun tooling").
  `jsr.json` describes the published JSR package, `package.json` is the Bun
  manifest, and `scripts/check-manifests.ts` keeps the two in sync (it is the
  canonical copy other wazootech repos take unchanged; `@std`
  packages are the default dependency, aliased as `npm:@jsr/...` in
  `package.json`). The sole module that touches the host runtime is the runtime
  edge, `src/runtime.ts`, which uses `node:` builtins so the engine runs on
  Bun, Node and Deno (through JSR's npm-compatibility layer and the published
  package; see ADR-0007). It is the only module allowed to import `node:*`.
  `src/` must not import `@std/fs` either: that package is Deno-only (`exists`
  and `walk` call the `Deno` global and throw under Node and Bun), which is why
  existence checks and tree walks go through the runtime edge's `pathExists` and
  `walkDirectoryTree`.
- TypeScript source in `src/`, tests in `tests/` (`node:test` and
  `node:assert/strict`, run by `bun test`; `tests/helpers.ts` holds the shared
  helpers). `tests/integration_test.ts` exercises real local git repositories
  under a temp dir.
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
bun install --frozen-lockfile --ignore-scripts
bun run ci
```

## Agent skills

This repo uses a lightweight skills/config scaffold under docs/agents/. The
canonical triage state labels are defined in docs/agents/triage-labels.md. For
how to file, label, and decide issues, follow docs/agents/issue-tracker.md.
Domain expectations live in docs/agents/domain.md.

## Code health

Family-wide rules live in the
[wazootech workspace constitution](https://github.com/wazootech/workspace/blob/main/AGENTS.md#code-health-standards);
this repo's specifics:

- **Before pushing**, run `bun run ci` (`bun fmt --check`, Oxlint,
  `lint:imports`, `bun check`, `check:manifests`, tests); CI runs the same task
  plus `bunx jsr publish --dry-run` and a `bun build --compile` smoke test.
- `no-explicit-any` is enforced by Oxlint (`--deny-warnings`,
  `.oxlintrc.json`) with no suppressions; `tsconfig.json` sets `strict` and
  CI installs with `--frozen-lockfile`.
- CI uses `oven-sh/setup-bun` with `bun-version: "1.x"` (Bun is the one
  deliberately unpinned toolchain); third-party actions are pinned to full
  commit SHAs with a version comment. The `jsr` CLI (pinned in
  `devDependencies`) bundles its own Deno-based publisher, so no Deno install is
  needed. Publishing runs on push to `main` and only when `jsr.json`'s version is
  not yet on JSR.
- `validate`'s dependency-age audit still reads `deno.json`/`deno.jsonc` files in
  other checkouts; that is CLI behavior, not this repo's toolchain.
- `secret-scan.yml` (gitleaks) runs on every PR and push to main; never suppress
  a finding.
- `code-health.yml` fails on a file over 120 lines of code (300 for tests);
  files that were already over it are listed there with a ceiling that only
  shrinks. A `TODO`/`FIXME` without an issue link only warns. `.github/CODEOWNERS` assigns review.
