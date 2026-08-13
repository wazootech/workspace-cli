---
name: wspace
description: Drive multi-repo Wazoo development: isolate tasks in Git worktrees, refresh default baselines safely, sync secrets, and open PRs. Use when launching an agent session in the Wazoo workspace, creating a feature worktree, checking baseline health, or running any wspace command.
---

# `wspace` workspace skill

Drive multi-repo development in the Wazoo workspace: discover state in one round
trip, isolate each task in a Git worktree, validate with native commands, and
land a PR. The goal is fewer tool calls and less context per session.

Command syntax and reference live in
[`references/COMMANDS.md`](references/COMMANDS.md). This file is the protocol.

## Launch hierarchy

Agent startup is a race to the first useful action. Choose the cheapest
discovery strategy that the launch context allows, in this order:

1. **Pre-seated cwd** (0 calls): When the orchestrator or handoff runner knows
   the target repo and feature branch, start the agent directly in
   `worktrees/<repo>/<feature>` (or `repos/<repo>`). No discovery needed.
2. **Explicit handoff metadata** (1 call): When launching at the workspace root
   with a known target, put `target_dir: worktrees/<repo>/<feature>` in the
   prompt context. Run one chained `cd <target_dir> && git status`.
3. **Root discovery** (1 round trip): When starting at the root without a
   target, do not probe subdirectories. Run one diagnostic query —
   `wspace check --json` or `wspace worktree list` — to learn every repository's
   state in a single round trip.

Batching is the standing rule: gather state in one shell call, never as per-repo
`ls` or `git status` probes.

## Pipeline

Complete one logical change per pass through this sequence. Each step ends on a
checkable condition before the next begins.

1. **Anchor the baseline.** From the workspace root, run `wspace check` and
   confirm the target repo is `CLEAN` or `FEATURE_CLEAN`. Refresh clean default
   branches with `wspace update` when the baseline may be stale.
2. **Isolate the task.** Create a worktree for the feature:
   `wspace worktree add <repo> <feature>`. Never edit `repos/<repo>` directly;
   work inside `worktrees/<repo>/<feature>/`. Sync local credentials with
   `wspace env sync` when the repo needs them.
3. **Implement.** Make the change inside the worktree. Commit one logical change
   at a time; do not stack unrelated work.
4. **Validate with commands, not deliberation.** Run the repo's native check
   suite — `deno task ci`, `npm run precommit`, or the documented equivalent. Do
   not reason about whether checks pass; run them. Format before staging and
   keep line endings as LF.
5. **Push and open a PR.** Push the branch and create the PR from inside the
   worktree. Watch the workflow to completion; do not merge while it is pending
   or failing.
6. **Clean up.** After merge, remove the worktree:
   `wspace worktree remove <repo> <feature>` and prune stale references. Leave
   the worktree clean before moving to the next task.

## Token and context economy

- Run checks and builds as shell commands, not AI reasoning. A passing test
  suite answers "is this done" in one call.
- Batch independent commands into a single shell call.
- Hand off a plan artifact between repos or phases, not the full conversation.
  Start each phase with the context it needs, nothing more.
- Leave per-repo command syntax to `references/COMMANDS.md`, reached on demand.

## Guardrails

- **Never mutate user work.** `wspace update` never resets, rebases, stashes, or
  rewrites history. It skips dirty and feature branches. Respect that contract;
  do not work around it with raw git destructive commands.
- **Root anchor.** All paths resolve relative to the directory containing the
  manifest. Use the `"$PWD/..."` form when running raw `git -C repos/<repo>`.
- **Central secret vault.** Never write `.env` files directly in `repos/` or
  `worktrees/`. Edit `secrets/<repo>/` and run `wspace env sync`.
