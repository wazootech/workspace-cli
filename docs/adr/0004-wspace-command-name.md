# ADR-0004: The `wspace` command name

- Status: accepted
- Date: 2026-08
- Updated: 2026-08 — decision revised to `wspace` (see below)

## Context

The CLI's command name has flipped once and is now settled, and the history is
kept in this single ADR so the full arc stays in one place.

1. **`wspace` (original).** The CLI shipped as `wspace` through
   `@wazoo/workspace@0.2.0`, alongside a `wspace.json` manifest-filename
   fallback and a packaged `wspace` agent skill.
2. **`works` (0.3.0).**
   [PR #62](https://github.com/wazootech/workspace-cli/pull/62) renamed the
   command, the JSR bin entry, the build output, and the packaged skill from
   `wspace` to `works`, bumping the release to 0.3.0. This was part of the
   manifest simplification to `workspace.json` / `.jsonc` only
   ([#67](https://github.com/wazootech/workspace-cli/pull/67)) and a broader
   naming pass. The `@wazoo/workspace` JSR package name and the
   `wazootech/workspace-cli` repository name were intentionally unchanged. The
   naming question resurfaced days later with an alternative candidate set —
   `wkspace`, `wkspc`, `wrksp`, `worksp` — alongside the possibility of
   reverting to `wspace`.

The 0.3.0 review initially kept `works`, weighing "already shipped" arguments
heavily. That decision did not stick. In practice `works` reads as the English
verb ("it works") and as a common noun ("the works"); it fails the tool's core
self-description, which is that it manages a _workspace_. The surrounding naming
family is unambiguous: the repository is `workspace-cli`, the package is
`@wazoo/workspace`, the manifest is `workspace.json`, and the directories are
`repos/`, `worktrees/`, and `secrets/`. The command name was the last member of
that family that did not point at "workspace" — and it is the one users type
most. The decision to revert was tracked in
[#105](https://github.com/wazootech/workspace-cli/issues/105) and executed as a
full org-wide pass renaming command, JSR bin entry, build output, packaged
skill, docs, guides, and harnesses from `works` to `wspace`, bumping the release
to 0.4.0.

## Decision

Use `wspace` as the command name. `works` is retired.

Rationale:

1. **Semantic link to the domain.** `wspace` unambiguously means "workspace" and
   joins the naming family the tool already owns (package `@wazoo/workspace`,
   manifest `workspace.json`, repository `workspace-cli`). `works` is
   homophonically ambiguous with the English verb/noun and does not
   self-describe as a workspace tool.
2. **Memorability.** `wspace` is a direct, typo-tolerant shortening of the
   domain word — `w` + `space` — shorter than `workspace`, and pairs with the
   tool's own `--workspace` flag and `workspaces` subcommand without colliding
   with either.
3. **Uniqueness.** `works` is an extremely common English word: prose and code
   search are noisy, and npm owns an unrelated abandoned `works`
   (`0.0.1-beta-7`) package that exports a conflicting `works` bin. `wspace` is
   effectively unique as a binary name and won't collide with other tools.
4. **The 0.3.0 decision is superseded.** The earlier review favored
   already-shipped, status-quo arguments. Those are one-time costs, not ongoing
   ergonomics; the naming tax is paid on every invocation, and the
   maintainer-weighted preference is `wspace`.

Accepted trade-offs:

- `wspace` is awkward to pronounce aloud ("wuh-space") relative to the real word
  `workspace`.
- npm already owns an unrelated `wspace` package (a context-switching CLI); the
  collision is name-branding only and does not affect the install path of
  `@wazoo/workspace` (JSR). Our bin is never registered on npm.
- The rename is a second repo-wide pass (command, bin, build output, skill,
  docs, guides, harnesses). It is deliberate and final: no further renames of
  this command are planned.

## Consequences

- `wspace` is declared in `deno.json`; the documented install is
  `deno install -g --name wspace jsr:@wazoo/workspace`; `deno task build` emits
  `wspace` (`wspace.exe` on Windows).
- The packaged agent skill is `wspace` (`skills/wspace/`), installed via
  `npx skills add wazootech/workspace-cli@wspace`.
- All usage lines, error messages, docs, hooks, and CI references read
  `wspace <command>`.
- Stale `works` binaries and shims on developer machines are removed when
  discovered; `/works` `/works.exe` ignore entries are superseded by `/wspace`
  `/wspace.exe`.
