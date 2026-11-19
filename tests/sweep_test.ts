import { assert, assertEquals } from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";
import { type GitRunner, worktreeList } from "@/git.ts";
import { run } from "@/cli.ts";
import { runSweep } from "@/sweep.ts";
import {
  addWorktree,
  configure,
  g,
  makeRepoWithMain,
  pathsFor,
  rebaseMerge,
  removeTempDir,
  slash,
} from "./sweep_helpers.ts";

Deno.test("sweep --dry-run plans removals and changes nothing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const wt = await addWorktree(work, dir, "feat/merged");
    await Deno.writeTextFile(join(wt, "a.txt"), "feature\n");
    await g.run(["add", "."], wt);
    await g.run(["commit", "-m", "feature"], wt);
    await rebaseMerge(dir, "a", "feature\n");
    await g.run(["fetch", "--prune"], work);

    const before = await worktreeList(g, work);
    const rows = await runSweep(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
      { dryRun: true },
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].kind, "WOULD_REMOVE");
    assertEquals(rows[0].name, "a");
    assertEquals(rows[0].branch, "feat/merged");
    assertEquals(slash(rows[0].worktree ?? ""), slash(wt));
    assertEquals(
      await worktreeList(g, work),
      before,
      "dry-run must not remove the worktree",
    );
    assert(await exists(wt), "dry-run must leave the tree on disk");
    assert(
      (await g.run(["rev-parse", "--verify", "refs/heads/feat/merged"], work))
        .code === 0,
      "dry-run must not delete the branch",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("sweep removes a rebase-merged worktree that branch -d would refuse", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const wt = await addWorktree(work, dir, "feat/rebased");
    await Deno.writeTextFile(join(wt, "a.txt"), "feature\n");
    await g.run(["add", "."], wt);
    await g.run(["commit", "-m", "feature"], wt);
    await rebaseMerge(dir, "a", "feature\n");
    await g.run(["fetch", "--prune"], work);

    const rows = await runSweep(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].kind, "SKIPPED_REMOTE");
    assertEquals(rows[0].name, "a");
    assertEquals(rows[0].branch, "feat/rebased");
    assertEquals(slash(rows[0].worktree ?? ""), slash(wt));
    assert(
      (rows[0].detail ?? "").startsWith("trees identical"),
      `expected a tree-equality proof, got: ${rows[0].detail}`,
    );
    assertEquals((await worktreeList(g, work)).length, 1, "worktree removed");
    assertEquals(await exists(wt), false, "tree gone from disk");
    // rev-parse --verify exits non-zero (128) for a ref that is gone.
    assert(
      (await g.run(["rev-parse", "--verify", "refs/heads/feat/rebased"], work))
        .code !== 0,
      "local branch deleted",
    );
    // The default: remote refs survive.
    assert(
      (await g.run([
        "rev-parse",
        "--verify",
        "refs/remotes/origin/feat/rebased",
      ], work)).code !== 0,
      "remote branch must be kept without --delete-remote",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("sweep --delete-remote removes the remote branch too", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const wt = await addWorktree(work, dir, "feat/pushed");
    await Deno.writeTextFile(join(wt, "a.txt"), "feature\n");
    await g.run(["add", "."], wt);
    await g.run(["commit", "-m", "feature"], wt);
    assert((await g.run(["push", "origin", "feat/pushed"], wt)).code === 0);
    await rebaseMerge(dir, "a", "feature\n");
    await g.run(["fetch", "--prune"], work);

    const rows = await runSweep(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
      { deleteRemote: true },
    );
    assertEquals(rows[0].kind, "REMOVED");
    assertEquals(
      (await g.run(["ls-remote", "--heads", "origin", "feat/pushed"], work))
        .stdout,
      "",
      "remote branch deleted",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("sweep refuses an unmerged branch", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const wt = await addWorktree(work, dir, "feat/wip");
    await Deno.writeTextFile(join(wt, "a.txt"), "work in progress\n");
    await g.run(["add", "."], wt);
    await g.run(["commit", "-m", "wip"], wt);

    const rows = await runSweep(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
      { dryRun: true },
    );
    assertEquals(rows[0].kind, "SKIP_NOT_MERGED");
    assert(await exists(wt), "unmerged worktree survives");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("sweep refuses a merged-but-dirty worktree and untracked files survive", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const wt = await addWorktree(work, dir, "feat/dirty");
    await Deno.writeTextFile(join(wt, "a.txt"), "feature\n");
    await g.run(["add", "."], wt);
    await g.run(["commit", "-m", "feature"], wt);
    await rebaseMerge(dir, "a", "feature\n");
    await g.run(["fetch", "--prune"], work);
    // Uncommitted work in the worktree: gate 2 must refuse.
    await Deno.writeTextFile(join(wt, "scratch.md"), "notes\n");

    const rows = await runSweep(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
    );
    assertEquals(rows[0].kind, "SKIP_DIRTY");
    assert(await exists(join(wt, "scratch.md")), "untracked file survives");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("sweep skips a detached-HEAD worktree", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const wt = join(dir, "wt-detached");
    assert((await g.run(["worktree", "add", "--detach", wt], work)).code === 0);

    const rows = await runSweep(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
    );
    assertEquals(rows[0].kind, "SKIP_DETACHED");
    assert(await exists(wt), "detached worktree survives");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("sweep never targets the default branch", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const wt = join(dir, "wt-main");
    // Move the primary checkout off main so the default branch itself can be
    // checked out in a linked worktree.
    assert((await g.run(["checkout", "-b", "side"], work)).code === 0);
    assert((await g.run(["worktree", "add", wt, "main"], work)).code === 0);

    const rows = await runSweep(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
    );
    assertEquals(rows[0].kind, "SKIP_DEFAULT");
    assert(await exists(wt), "default-branch worktree survives");
    assert(
      (await g.run(["rev-parse", "--verify", "refs/heads/main"], work)).code ===
        0,
      "default branch survives",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("sweep --force overrides both safety gates", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const wt = await addWorktree(work, dir, "feat/unmerged-dirty");
    // Unmerged and dirty: both gates would refuse.
    await Deno.writeTextFile(join(wt, "a.txt"), "unmerged work\n");
    await g.run(["add", "."], wt);
    await g.run(["commit", "-m", "unmerged"], wt);
    await Deno.writeTextFile(join(wt, "scratch.md"), "notes\n");

    const rows = await runSweep(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
      { dryRun: true, force: true },
    );
    assertEquals(rows[0].kind, "WOULD_REMOVE");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("sweep includes the workspace root's own worktrees", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const rootDir = join(dir, "root");
    const work = await makeRepoWithMain(dir, "root");
    // The motivating case: the root repo carries a worktree that no manifest
    // entry can reach.
    await addWorktree(work, dir, "feat/root-work");
    Deno.renameSync(work, rootDir);

    const rows = await runSweep(
      g,
      { repositories: [] },
      { root: rootDir, repositoriesDirectory: join(dir, "repos") },
      { dryRun: true },
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].name, "(workspace root)");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("sweep does not leak root worktrees through a non-repo repositories dir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // A root repo with a linked worktree...
    const rootDir = join(dir, "root");
    const work = await makeRepoWithMain(dir, "root");
    await addWorktree(work, dir, "feat/root-only");
    Deno.renameSync(work, rootDir);

    // ...and a repos/ directory that exists but holds no git repo, mirroring
    // the real workspace's repos/worktrees/. A git command run there without a
    // .git guard would walk up and report the ROOT repo's worktrees.
    await Deno.mkdir(join(dir, "repos", "worktrees"), { recursive: true });

    const rows = await runSweep(
      g,
      { repositories: [] },
      {
        root: join(dir, "repos", "worktrees"),
        repositoriesDirectory: join(dir, "repos"),
      },
      { dryRun: true },
    );
    assertEquals(rows, [], "non-repo root must yield no rows at all");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("sweep produces no rows for a repository with no linked worktrees", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await makeRepoWithMain(dir, "a");
    const rows = await runSweep(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
      { dryRun: true },
    );
    assertEquals(rows, []);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("sweep exits 0 for refusals and 1 for failures", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const rootDir = join(dir, "root");
    const work = await makeRepoWithMain(dir, "root");
    await addWorktree(work, dir, "feat/wip2");
    await Deno.writeTextFile(
      join(rootDir, "..", "wt-feat-wip2", "a.txt"),
      "wip\n",
    );
    const wt = join(dir, "wt-feat-wip2");
    await g.run(["add", "."], wt);
    await g.run(["commit", "-m", "wip"], wt);
    await Deno.writeTextFile(
      join(rootDir, "workspace.json"),
      JSON.stringify({
        schemaVersion: 4,
        workspaceRoot: rootDir,
        repositories: [],
      }),
    );
    await configure(rootDir);
    await g.run(["add", "."], rootDir);
    await g.run(["commit", "-m", "manifest"], rootDir);
    await g.run(["push", "origin", "main"], rootDir);

    const manifestPath = join(rootDir, "workspace.json");
    // An unmerged branch is a refusal, not a failure.
    assertEquals(
      await run(["sweep", "--offline", "--manifest", manifestPath]),
      0,
    );
    // --strict promotes refusals to a non-zero exit.
    assertEquals(
      await run(["sweep", "--offline", "--strict", "--manifest", manifestPath]),
      1,
    );
    // Nothing to sweep at all is still success.
    assertEquals(
      await run([
        "sweep",
        "--offline",
        "--dry-run",
        "--manifest",
        manifestPath,
      ]),
      0,
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("sweep --json emits machine-readable rows", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await addWorktree(work, dir, "feat/unmerged3");
    await Deno.writeTextFile(
      join(work, "..", "wt-feat-unmerged3", "a.txt"),
      "x\n",
    );
    const wt = join(dir, "wt-feat-unmerged3");
    await g.run(["add", "."], wt);
    await g.run(["commit", "-m", "x"], wt);

    const manifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 4,
        workspaceRoot: dir,
        repositoriesDirectory: ".",
        repositories: [{ name: "a", url: join(dir, "a.git") }],
      }),
    );

    const original = console.log;
    let output = "";
    console.log = (...args: unknown[]) => {
      output += args.map(String).join(" ") + "\n";
    };
    const code = await run([
      "sweep",
      "--offline",
      "--json",
      "--dry-run",
      "--manifest",
      manifestPath,
    ]);
    console.log = original;

    assertEquals(code, 0);
    const rows = JSON.parse(output);
    assertEquals(rows[0].kind, "SKIP_NOT_MERGED");
    assertEquals(rows[0].branch, "feat/unmerged3");
  } finally {
    await removeTempDir(dir);
  }
});

export type { GitRunner };
