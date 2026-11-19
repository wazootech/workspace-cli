import { assert, assertEquals } from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";
import type { GitResult, GitRunner } from "@/git.ts";
import { runSweep, type SweepOptions } from "@/sweep.ts";
import {
  addWorktree,
  g,
  makeRepoWithMain,
  pathsFor,
  removeTempDir,
} from "./sweep_helpers.ts";

// The remote proof tier: a squash- or rebase-merged PR leaves `main` moved on,
// so no offline tier can see it, and `gh` is asked whether the PR was merged.
// A scripted `gh` keeps these tests hermetic.

interface FakeGh extends GitRunner {
  calls: string[][];
}

function fakeGh(result: Partial<GitResult> | Error): FakeGh {
  const calls: string[][] = [];
  return {
    calls,
    run(args: string[]): Promise<GitResult> {
      calls.push(args);
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve({ code: 0, stdout: "[]", stderr: "", ...result });
    },
  };
}

function prList(...prs: Array<{ number: number; headRefOid: string }>): string {
  return JSON.stringify(prs);
}

async function sha(dir: string, ref: string): Promise<string> {
  return (await g.run(["rev-parse", ref], dir)).stdout;
}

/**
 * A pushed feature branch whose PR was squash-merged: main gained an unrelated
 * commit too, so tree equality, an empty diff, and ancestry all fail offline.
 */
async function squashMergedBranch(dir: string, branch: string) {
  const work = await makeRepoWithMain(dir, "a");
  const wt = await addWorktree(work, dir, branch);
  await Deno.writeTextFile(join(wt, "a.txt"), "feature\n");
  await g.run(["add", "."], wt);
  assert((await g.run(["commit", "-m", "feature"], wt)).code === 0);
  assert((await g.run(["push", "origin", branch], wt)).code === 0);

  const seed = join(dir, "a-seed");
  await Deno.writeTextFile(join(seed, "a.txt"), "feature\n");
  await Deno.writeTextFile(join(seed, "b.txt"), "someone else's work\n");
  await g.run(["add", "."], seed);
  assert((await g.run(["commit", "-m", "squash"], seed)).code === 0);
  assert((await g.run(["push", join(dir, "a.git"), "main"], seed)).code === 0);
  await g.run(["fetch", "--prune"], work);
  return { work, wt, prHead: await sha(wt, "HEAD") };
}

async function sweep(
  dir: string,
  options: SweepOptions,
) {
  return await runSweep(
    g,
    { repositories: [{ name: "a", url: "u" }] },
    pathsFor(dir),
    options,
  );
}

Deno.test("without gh, a squash-merged branch has no merge proof", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await squashMergedBranch(dir, "feat/squashed");
    const rows = await sweep(dir, { dryRun: true });
    assertEquals(rows[0].kind, "SKIP_NOT_MERGED");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("a merged PR whose head is the branch tip is proven", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { wt, prHead } = await squashMergedBranch(dir, "feat/squashed");
    const gh = fakeGh({ stdout: prList({ number: 7, headRefOid: prHead }) });
    const rows = await sweep(dir, { dryRun: true, gh });
    assertEquals(rows[0].kind, "WOULD_REMOVE");
    assertEquals(rows[0].detail, "PR #7 merged, tip == PR head");
    assert(await exists(wt), "dry-run leaves the worktree");
    // Only merged PRs into the default branch count.
    const args = gh.calls[0];
    assertEquals(args.slice(0, 2), ["pr", "list"]);
    assertEquals(args[args.indexOf("--head") + 1], "feat/squashed");
    assertEquals(args[args.indexOf("--base") + 1], "main");
    assertEquals(args[args.indexOf("--state") + 1], "merged");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("a rebased local tip with the PR head's tree is proven", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { wt, prHead } = await squashMergedBranch(dir, "feat/rebased-tip");
    // Reword locally: a new SHA, the same tree, as after a local rebase.
    assert(
      (await g.run(["commit", "--amend", "-m", "feature, reworded"], wt))
        .code === 0,
    );
    assert((await sha(wt, "HEAD")) !== prHead, "tip must differ from PR head");

    const gh = fakeGh({ stdout: prList({ number: 9, headRefOid: prHead }) });
    const rows = await sweep(dir, { dryRun: true, gh });
    assertEquals(rows[0].kind, "WOULD_REMOVE");
    assertEquals(rows[0].detail, "PR #9 merged, tip tree == PR head");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("work added after the PR merged is never proven", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { wt, prHead } = await squashMergedBranch(dir, "feat/more-work");
    await Deno.writeTextFile(join(wt, "c.txt"), "started after the merge\n");
    await g.run(["add", "."], wt);
    assert((await g.run(["commit", "-m", "more"], wt)).code === 0);

    const gh = fakeGh({ stdout: prList({ number: 7, headRefOid: prHead }) });
    const rows = await sweep(dir, { dryRun: true, gh });
    assertEquals(rows[0].kind, "SKIP_NOT_MERGED");
    assert(await exists(wt), "worktree with new work survives");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("a PR head that is a different commit is not proof", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await squashMergedBranch(dir, "feat/other-pr");
    const unrelated = "0".repeat(40);
    const gh = fakeGh({ stdout: prList({ number: 3, headRefOid: unrelated }) });
    const rows = await sweep(dir, { dryRun: true, gh });
    assertEquals(rows[0].kind, "SKIP_NOT_MERGED");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("a gh failure leaves the offline result unchanged", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await squashMergedBranch(dir, "feat/gh-down");
    const failing = fakeGh({ code: 1, stderr: "gh: not logged in" });
    assertEquals(
      (await sweep(dir, { dryRun: true, gh: failing }))[0].kind,
      "SKIP_NOT_MERGED",
    );
    // `gh` missing entirely: the runner rejects when it cannot spawn.
    const missing = fakeGh(new Error("spawn gh ENOENT"));
    assertEquals(
      (await sweep(dir, { dryRun: true, gh: missing }))[0].kind,
      "SKIP_NOT_MERGED",
    );
    // Malformed output is ignored too.
    const garbled = fakeGh({ stdout: "not json" });
    assertEquals(
      (await sweep(dir, { dryRun: true, gh: garbled }))[0].kind,
      "SKIP_NOT_MERGED",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("the dirty-tree gate still applies to a PR-proven branch", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { wt, prHead } = await squashMergedBranch(dir, "feat/dirty-pr");
    await Deno.writeTextFile(join(wt, "scratch.md"), "notes\n");
    const gh = fakeGh({ stdout: prList({ number: 7, headRefOid: prHead }) });
    const rows = await sweep(dir, { gh });
    assertEquals(rows[0].kind, "SKIP_DIRTY");
    assert(await exists(join(wt, "scratch.md")), "untracked file survives");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("a real sweep fetches a PR head it lacks; a dry run does not", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { work, wt } = await squashMergedBranch(dir, "feat/lost-head");
    // The PR's own head commit, reachable only through refs/pull/5/head: same
    // tree as the branch, different SHA, and absent from the local clone.
    const seed = join(dir, "a-seed");
    await g.run(["checkout", "--detach", "HEAD~1"], seed);
    await Deno.writeTextFile(join(seed, "a.txt"), "feature\n");
    await g.run(["add", "."], seed);
    assert((await g.run(["commit", "-m", "pr head"], seed)).code === 0);
    const prHead = await sha(seed, "HEAD");
    assert(
      (await g.run(["push", join(dir, "a.git"), "HEAD:refs/pull/5/head"], seed))
        .code === 0,
    );
    const gh = fakeGh({ stdout: prList({ number: 5, headRefOid: prHead }) });

    const preview = await sweep(dir, { dryRun: true, gh });
    assertEquals(preview[0].kind, "SKIP_NOT_MERGED", "dry run must not fetch");

    const rows = await sweep(dir, { gh });
    assertEquals(rows[0].kind, "SKIPPED_REMOTE");
    assertEquals(rows[0].detail, "PR #5 merged, tip tree == PR head");
    assertEquals(await exists(wt), false, "tree gone from disk");
    assert(
      (await g.run(
        ["rev-parse", "--verify", "refs/heads/feat/lost-head"],
        work,
      ))
        .code !== 0,
      "local branch deleted",
    );
  } finally {
    await removeTempDir(dir);
  }
});
