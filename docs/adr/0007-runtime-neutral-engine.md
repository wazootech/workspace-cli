# ADR-0007: The engine runs on Deno and Node, through one runtime edge

- Status: accepted
- Date: 2026-10
- Amends: ADR-0006 (its purge strategies named `Deno.remove` directly)
- Related: issues [#160](https://github.com/wazootech/workspace-cli/issues/160),
  [#159](https://github.com/wazootech/workspace-cli/issues/159),
  [#135](https://github.com/wazootech/workspace-cli/issues/135),
  [#29](https://github.com/wazootech/workspace-cli/issues/29)

## Context

`wspace` had exactly one distribution path that did not require a Deno
installation: a compiled binary built by `deno task build`. Everything else —
`deno run jsr:@wazoo/workspace/cli`, `deno install` — presumes Deno on the
machine.

JSR also serves an **npm-compatibility** form of every package, which
`npx jsr
add @wazoo/workspace` installs without Deno present at all. Measured
against the published `0.7.0`, that form is _mechanically_ ready:

- it ships transpiled `.js` beside the `.ts`,
- it rewrites the `@/x.ts` alias to the correct relative path per directory, and
  `jsr:@std/fs` to `@jsr/std__fs`,
- Node 24 loaded the whole module graph, resolved `@jsr/std__cli/parse-args`,
  and honoured `import.meta.main`.

It then died at `ReferenceError: Deno is not defined`. JSR transpiles; it does
not shim Deno globals. That single fact — not packaging, not the alias, not the
`@std` specs — was the whole barrier between "JSR serves a Node package" and
"JSR serves a Node package that runs".

Two constraints frame the decision. JSR's npm-compat layer forwards only
`exports`, never `bin`
([#135](https://github.com/wazootech/workspace-cli/issues/135)), so a `wspace`
**command** on `PATH` still needs a wrapper; the port buys a runnable **library
and CLI entry**, not a shim. And the alternative route — compiled binaries per
platform ([#29](https://github.com/wazootech/workspace-cli/issues/29)) — ships
no cross-platform runtime code but does ship a large artifact matrix.

## Decision

1. **Remove every `Deno.*` global from `src/`.** `Deno.args` and `Deno.exit` in
   `src/cli.ts` were the last two.

2. **Confine all host access to one module, `src/runtime.ts`.** It imports
   `node:child_process`, `node:fs/promises`, `node:os` and `node:process`, which
   Deno implements natively, so a single implementation serves both runtimes.
   Nothing else in `src/` may import `node:*`. This is the one documented
   exception to the "@std only" rule; `src/runtime.ts` is also the only module
   permitted to reference `npm:@types/node`, which is now the project's sole
   non-`@std` dependency (type-only, declared in `deno.json`).

3. **`runProcess` preserves the two subprocess behaviours callers depend on.**
   It resolves for _every_ exit code — including non-zero — so callers keep
   classifying failure from `code`, and it rejects only when the binary cannot
   be spawned at all. That rejection is load-bearing: it is how
   `createGitHubRepoWithFallback` recognises "gh CLI is not available". Stdin is
   detached so a subprocess cannot block on a credential prompt.

4. **Host differences are normalised in exactly one place each, and never by
   hand at a call site.** `Deno.build.os` says `"windows"` where
   `process.platform` says `"win32"`, so Windows checks go through
   `isWindows()`. `Deno.args` has no Node equivalent, so `cliArgs` derives
   arguments from `process.argv.slice(2)`, which is correct in all three
   invocation shapes — `deno run` (`[deno, script, ...]`), a compiled binary
   (`[exe, exe, ...]`, Deno duplicates the path to mimic Node), and
   `node <script>` (`[node, script, ...]`).

5. **Exiting sets `process.exitCode` rather than calling `process.exit`.**
   Exiting immediately can truncate buffered stdout when output is piped, which
   would corrupt the `--json` contract that tooling consumes. Both runtimes
   honour the exit code.

6. **The engine stays Deno-tested.** The 185 Deno tests are not rewritten; they
   are the behaviour-parity gate, and Deno loads `node:` builtins natively.
   `tests/runtime_test.ts` covers the runtime edge directly, including the
   non-zero-exit and missing-binary branches above.

7. **The compiled binary's permission set is corrected.** `deno task build`
   allowed only `--allow-run=git`, but the code also spawns `gh`
   (`wspace add
   --create`) and `robocopy`, `rmdir` and `rm` (the ADR-0006
   purge ladder); `deno compile` bakes permissions in, so those paths would
   throw `PermissionDenied`. The allowlist now names all five.

## Consequences

- **The npm-compat package becomes runnable, not merely installable.**
  `npx jsr
  add @wazoo/workspace` still needs no Deno, and
  `node .../src/cli.js <cmd>` now executes. ADR-0006's purge ladder,
  `wspace check --json`, and the rest of the engine come with it.
- **No `node_modules/` directory is created for the repo.** `@types/node` is
  resolved through Deno's global cache, so `deno check`, `deno compile` and the
  publish flow are unaffected by the new dependency being npm-shaped.
- **The Deno sandbox no longer constrains Node consumers — a real regression.**
  Under Deno, `--allow-run=git,gh,robocopy,rmdir,rm` and `--allow-read`/`-write`
  are enforced; the same code run on Node runs with the user's full ambient
  authority. That is inherent to "runs on Node", and worth stating plainly
  rather than discovering later.
- **Getting `wspace` onto `PATH` is explicitly out of scope.** JSR does not
  forward `bin`, and this ADR does not add an npm wrapper; [#135] tracks that
  separately.
- **The version bumps.** JSR is immutable, so the port and the previously
  unshipped `sweep`/`purge` ([#159]) both require moving off the published
  `0.7.0`; the release carries both.
- **A faithful end-to-end test requires a pre-release.** JSR builds the
  npm-compat tarball only at publish time, and `deno transpile` output is not
  directly Node-loadable (it leaves `jsr:` specifiers), so verification is an
  `-rc` publish plus a real `npx jsr add` install.
