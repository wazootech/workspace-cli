---
name: wspace
description: 'Drive multi-repo Wazoo development: isolate tasks in Git worktrees, refresh default baselines safely, sync secrets, validate with native CI, and open PRs. For goal-oriented runs — "keep iterating", "clear the backlog", "drive this autonomously", "goal mode", "run the loop" — drive the goal loop across many wayfinder tickets, filing blockers as new tickets and stopping only at deploy/publish or HITL boundaries. Use when launching an agent session in the Wazoo workspace, creating a feature worktree, checking baseline health, running any wspace command, or pushing a goal to completion.'
---

# `wspace` workspace skill

Drive multi-repo development in the Wazoo workspace: discover state in one round
trip, isolate each task in a Git worktree, validate with native commands, and
land a PR. The goal is fewer tool calls and less context per session.

Command syntax and reference live in
[`references/COMMANDS.md`](references/COMMANDS.md). This file is the protocol.

This skill covers two modes, one file:

- **One change** — the **Pipeline** below: a single logical change from baseline
  to PR. Use it for any ordinary task.
- **One goal** — the **Goal loop** below: many wayfinder tickets toward a
  destination, with blockers filed as new tickets and hard deploy/HITL
  boundaries. Use it for "keep iterating", "clear the backlog", "goal mode", or
  "run the loop".

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

## Goal loop

The **execution** half of wayfinding. The Wayfinder conventions in the workspace
root `AGENTS.md` (the map, ticket labels, frontier, claim, and recording rules)
chart _decision_ tickets and resolve them one at a time — "plan, don't do". This
loop carries execution into the map, driving the `wayfinder:task` tickets — the
one type that _does_ rather than decides — to completion, one worktree + PR at a
time, until the goal is reached or a hard boundary stops it.

It adds the **outer loop**: given a goal, keep choosing → executing → recording
without stalling, and stop only at an explicit boundary. Each pass's EXECUTE
phase is the Pipeline above, verbatim — never re-specified here.

### The loop

One pass through this sequence per ticket. Every phase leaves a verifiable
artifact, so a re-run is safe and a fresh session can resume.

```
GOAL
 └─► 1. FRAME    restate the goal; write it (or its pointer) as the resume anchor.
 └─► 2. SCAN     one frontier query: open, unblocked, unclaimed wayfinder tickets.
 └─► 3. CLAIM    assign yourself before any work; append to the FIFO queue.
 └─► 4. EXECUTE  decompose → worktree → implement → validate → PR   (the Pipeline above).
 └─► 5. REFLECT  one of three outcomes:
       • DONE     record the decision line on the map, close the ticket, loop to SCAN.
       • BLOCKED  file a new wayfinder ticket for the blocker, wire the dependency,
                  append it to the FIFO, loop to SCAN.
       • BOUNDARY deploy / publish / HITL required → stop and hand back. Never loop past it.
```

#### 1. FRAME

Restate the goal in one line and record it. The destination is the thing to
reach, not a spec to produce — this is a build effort, so the map's `## Notes`
should carry the override: _"carrying execution into the map"_. If no map exists
yet and the goal is small enough to fit one session, don't chart a map — just do
it. If it's multi-session, chart the map with the Wayfinder conventions first.

#### 2. SCAN

Find the frontier — open, unblocked, unclaimed tickets. `gh search issues` ANDs
repeated `--label` values and rejects qualifier-only `OR`, so query **one label
at a time and merge**:

```sh
for l in wayfinder:task wayfinder:grilling wayfinder:prototype wayfinder:research; do
  gh search issues --owner wazootech --label "$l" --state open --assignee "" \
    --json number,title,repository --limit 200
done | jq -s 'add | unique_by(.repository.name + "#" + (.number|tostring))'
```

A ticket is **unblocked** when everything blocking it is closed. Prefer
`wayfinder:task` tickets first — they are the ones that _do_.

#### 3. CLAIM

```sh
gh issue edit <n> --repo <owner>/<repo> --add-assignee <your-login>
```

Assignment **is** the claim; concurrent sessions skip an assigned ticket.
Maintain a FIFO in the map's **Active tickets** section so the order survives a
session restart.

#### 4. EXECUTE

Run the Pipeline above verbatim: anchor the baseline, create the worktree, make
the change (one logical change per commit), validate with native CI, push, open
the PR. Watch CI to green; do not hand off while it is pending or failing.

#### 5. REFLECT

Three outcomes, and only three:

- **DONE** — post the answer as a resolution comment, close the ticket, append
  one line to the map's **Decisions so far**:
  `- [<ticket title>](link) — <one-line gist>`. Then loop to SCAN.
- **BLOCKED** — the next step depends on something not yet true (an unpublished
  release, a missing permission, another repo's change). File a new ticket for
  the blocker in its owning repo, wire the dependency both ways (link the
  blocker from the blocked ticket and the blocked ticket from the blocker), post
  a "blocked by" comment, append the blocker to the FIFO, and loop to SCAN. Do
  **not** sit on the blocked ticket — the queue keeps moving; you revisit it
  when its dependency lands.
- **BOUNDARY** — the remaining work requires a deploy/publish or a human
  decision. Stop, post a crisp "needs human" hand-back (what, why, the exact
  one-click next action), and end the session.

### Queue discipline

Blockers are **appended**, not interleaved — first-in, first-out — so a blocked
ticket never dead-ends the loop: it files its blocker and moves on. When a
blocker closes, the ticket it was blocking re-enters the frontier and is picked
up again in order. If a new blocker for the _current_ ticket surfaces
mid-execution, file it and return to it after the current FIFO drains (last-in,
last-out within a single ticket's sub-steps).

### Hard boundaries

These terminate the iteration and force a hand-back. The loop may **not** cross
them; the Pipeline guardrails below (worktree isolation, never mutate user work)
apply to every pass.

- **Deploy / publish.** Merging a publish-triggering PR, `deno publish`,
  `gh release`, deploy workflows, or any production mutation requires explicit
  human approval. The loop may _open_ the PR and stop; it does not merge or
  publish.
- **HITL tickets.** `wayfinder:grilling`, `wayfinder:prototype`, and human-gated
  `wayfinder:task` resolve only through a live human exchange (invoke
  `/grilling` and `/domain-modeling`). **Never resolve more than one HITL ticket
  per session** — surface it, get the answer, record, stop. Research tickets are
  the exception: batch them via `/research` subagents.
- **Refer by name.** Narration and the map cite tickets by title (name wraps the
  link), never a bare id — the Wayfinder convention.

### Budget & checkpoint

- **Per-session budget** is set at FRAME: a maximum ticket count, a wall-clock
  cap, and a context/token cap. When any cap is hit, checkpoint and stop — do
  not start a ticket you can't finish.
- **Checkpoint** = the map. Before stopping, ensure the FIFO, the decision
  lines, and every open blocker/PR link are recorded there, so the next session
  resumes from the map without re-deriving state.

### Done when

The goal is reached and every ticket in its FIFO is closed or ruled out of scope
— or the loop has stopped cleanly at a boundary with a "needs human" hand-back.
The map is the source of truth for which of those two happened.

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
- **Tip-diff before stranded-work claims.** `FEATURE_CLEAN` plus "commits ahead"
  usually means a squash merge detached the branch, not that work is lost.
  Confirm with `git diff origin/main HEAD` and apply the root AGENTS.md
  **Upstream verification** rules before planning around it.
