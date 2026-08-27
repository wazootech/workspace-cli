# ADR-0004: The `works` command name

- Status: accepted
- Date: 2026-08

## Context

The CLI shipped under the command name `wspace` through `@wazoo/workspace`
0.2.0, alongside a `wspace.json` manifest-filename fallback and a packaged
`wspace` agent skill. As part of the manifest simplification to `workspace.json`
/ `.jsonc` only ([#67](https://github.com/wazootech/workspace-cli/pull/67)) and
a broader naming pass,
[PR #62](https://github.com/wazootech/workspace-cli/pull/62) renamed the
command, the JSR bin entry, the build output, and the packaged skill from
`wspace` to `works`, bumping the release to 0.3.0. The `@wazoo/workspace` JSR
package name and the `wazootech/workspace-cli` repository name were
intentionally unchanged.

Days later the naming question resurfaced with an alternative candidate set —
`wkspace`, `wkspc`, `wrksp`, `worksp` — alongside the possibility of reverting
to `wspace`.

## Decision

Keep `works` as the command name. Do not rename to `wspace` or any compressed
variant.

Rationale:

1. **Already shipped and installed.** `deno.json` declares the bin `works`; the
   documented install (`deno install -g --name works jsr:@wazoo/workspace`)
   produces a global `works` binary; the packaged agent skill is named `works`
   and is installed at user level; and roughly 230 `works <cmd>` references
   describe the tool across the organization's guides, READMEs, ADRs, tests, and
   skills. Every usage line and error message in the CLI itself reads
   `works <command>`.
2. **`wspace` was deliberately retired.** PR #62 migrated off it less than a
   week before this review, and the `wspace.json`/`repos.json` filename
   fallbacks were removed in #67. Reverting would flip-flop on the just-landed
   decision and re-import a name that an unrelated npm package (`wspace`, a
   context-switching CLI) already occupies.
3. **The compressed variants are strictly worse.** `wkspc`, `wrksp`, `wkspace`,
   and `worksp` are collision-free on major registries but are unpronounceable
   or typo-prone (dropped-vowel ambiguity: which vowel was dropped?), carry no
   semantic or ergonomic advantage over `works`, and would incur the full rename
   cost — a second repo-wide pass, binary and skill reinstall, and re-edit of
   the same guides — within the same week.
4. **`works` keeps the properties that matter.** Spellable, pronounceable,
   connected to "workspace", and distinct from the `workspaces` subcommand and
   the `@wazoo/workspace` package name while pairing with them.

## Consequences

- Accepted trade-offs: `works` is a common English word, so prose and code
  search are noisy, and npm owns an unrelated abandoned `works` (`0.0.1-beta-7`)
  package that exports a conflicting `works` bin. Neither affects the install
  path used here, and no action is required.
- Future renames clear a higher bar: strong collision or ergonomics evidence,
  plus a deprecation alias shipped for one minor version before removal.
- Stale `wspace` shims from `@wazoo/workspace@0.2.0` left behind on developer
  machines are removed when discovered; they are not part of the codebase.
