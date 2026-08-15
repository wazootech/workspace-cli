---
name: wspace-loop
description: Drive a goal to completion across many wayfinder tickets and repos — scan the frontier, claim the next unblocked task, execute it in a worktree with CI, file blockers as new tickets, record decisions, and repeat until done or a hard boundary (deploy/HITL) is reached. Use for "keep iterating", "clear the backlog", "drive this autonomously", "goal mode", "run the loop", or any request to keep making progress until a goal is met.
---

# `wspace-loop` — goal-oriented execution loop

`wspace-loop` is the **execution** half of wayfinding. The
[`wayfinder`](/wayfinder) skill charts a shared map of _decision_ tickets and
resolves them one at a time — "plan, don't do". This skill is for the efforts
whose **destination is a change made in place**: it carries execution into the
map, driving the `task` tickets (the one type that _does_ rather than decides)
to completion, one worktree + PR at a time, until the goal is reached or a hard
boundary stops it.

It layers on top of two existing skills, never re-specifying them:

- **`wayfinder`** owns the map, tickets, frontier, claim, and recording
  conventions. Follow it for anything about _planning_.
- **`wspace`** owns the workspace mechanics: baseline anchor, worktree
  isolation, validation, PR, cleanup. Follow it for the _mechanics_ of one
  change.

`wspace-loop` adds the **outer loop**: given a goal, keep choosing → executing →
recording without stalling, and stop only at an explicit boundary.

## The loop

One pass through this sequence per ticket. Every phase leaves a verifiable
artifact, so a re-run is safe and a fresh session can resume.

```
GOAL
 └─► 1. FRAME    restate the goal; write it (or its pointer) as the resume anchor.
 └─► 2. SCAN     one frontier query: open, unblocked, unclaimed wayfinder tickets.
 └─► 3. CLAIM    assign yourself before any work; append to the FIFO queue.
 └─► 4. EXECUTE  decompose → worktree → implement → validate → PR   (the wspace skill).
 └─► 5. REFLECT  one of three outcomes:
       • DONE     record the decision line on the map, close the ticket, loop to SCAN.
       • BLOCKED  file a new wayfinder ticket for the blocker, wire the dependency,
                  append it to the FIFO, loop to SCAN.
       • BOUNDARY deploy / publish / HITL required → stop and hand back. Never loop past it.
```

### 1. FRAME

Restate the goal in one line and record it. The destination is the thing to
reach, not a spec to produce — this is a build effort, so the map's `## Notes`
should carry the override: _"carrying execution into the map"_. If no map exists
yet and the goal is small enough to fit one session, don't chart a map — just do
it. If it's multi-session, chart the map with `wayfinder` first.

### 2. SCAN

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

### 3. CLAIM

```sh
gh issue edit <n> --repo <owner>/<repo> --add-assignee <your-login>
```

Assignment **is** the claim; concurrent sessions skip an assigned ticket.
Maintain a FIFO in the map's **Active tickets** section so the order survives a
session restart.

### 4. EXECUTE

Delegate to the `wspace` skill verbatim: anchor the baseline, create the
worktree, make the change (one logical change per commit), validate with native
CI (`deno task ci` / the repo's equivalent), push, open the PR. Watch CI to
green; do not hand off while it is pending or failing.

### 5. REFLECT

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

## Queue discipline

Blockers are **appended**, not interleaved — first-in, first-out — so a blocked
ticket never dead-ends the loop: it files its blocker and moves on. When a
blocker closes, the ticket it was blocking re-enters the frontier and is picked
up again in order. If a new blocker for the _current_ ticket surfaces
mid-execution, file it and return to it after the current FIFO drains (last-in,
last-out within a single ticket's sub-steps).

## Guardrails — hard boundaries

These terminate the iteration and force a hand-back. The loop may **not** cross
them:

- **Deploy / publish.** Merging a publish-triggering PR, `deno publish`,
  `gh release`, deploy workflows, or any production mutation requires explicit
  human approval. The loop may _open_ the PR and stop; it does not merge or
  publish.
- **HITL tickets.** `wayfinder:grilling`, `wayfinder:prototype`, and human-gated
  `wayfinder:task` resolve only through a live human exchange (invoke
  `/grilling` and `/domain-modeling`). **Never resolve more than one HITL ticket
  per session** — surface it, get the answer, record, stop. Research tickets are
  the exception: batch them via `/research` subagents.
- **Destructive / other people's work.** No force-push, reset, rebase, stash, or
  discard of changes the loop did not author; no `git add -A`; never overwrite,
  stash, stage, or commit work that isn't yours.
- **Worktree isolation.** Never edit `repos/<repo>` directly; work in
  `worktrees/<repo>/<feature>/`. One logical change per commit. CI must be green
  before a PR is handed off.
- **Refer by name.** Narration and the map cite tickets by title (name wraps the
  link), never a bare id — the wayfinder convention.

## Budget & checkpoint

- **Per-session budget** is set at FRAME: a maximum ticket count, a wall-clock
  cap, and a context/token cap. When any cap is hit, checkpoint and stop — do
  not start a ticket you can't finish.
- **Checkpoint** = the map. Before stopping, ensure the FIFO, the decision
  lines, and every open blocker/PR link are recorded there, so the next session
  resumes from the map without re-deriving state.

## Done when

The goal is reached and every ticket in its FIFO is closed or ruled out of scope
— or the loop has stopped cleanly at a BOUNDARY with a "needs human" hand-back.
The map is the source of truth for which of those two happened.
