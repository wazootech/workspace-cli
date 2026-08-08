import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  branchAb,
  defaultBranch,
  type GitRunner,
  isDirty,
  SystemGit,
} from "../src/git.ts";
import type { ManifestPaths } from "../src/manifest.ts";
import { exists } from "../src/manifest.ts";
import { run } from "../src/cli.ts";
import { collectStatus } from "../src/status.ts";
import { runUpdate } from "../src/update.ts";
import {
  addWorktree,
  listWorktrees,
  removeWorktree,
} from "../src/worktrees.ts";

const g = new SystemGit();

async function configure(dir: string): Promise<void> {
  await g.run(["config", "user.email", "wspace-test@example.com"], dir);
  await g.run(["config", "user.name", "WSC Test"], dir);
  await g.run(["config", "commit.gpgsign", "false"], dir);
}

async function makeRepoWithMain(dir: string, name: string): Promise<string> {
  const origin = join(dir, `${name}.git`);
  const seed = join(dir, `${name}-seed`);
  assert((await g.run(["init", "--bare", origin])).code === 0, "init bare");
  assert((await g.run(["init", seed])).code === 0, "init seed");
  await configure(seed);
  assert(
    (await g.run(["checkout", "-b", "main"], seed)).code === 0,
    "checkout main",
  );
  await Deno.writeTextFile(join(seed, "a.txt"), "one\n");
  await g.run(["add", "."], seed);
  assert(
    (await g.run(["commit", "-m", "seed"], seed)).code === 0,
    "seed commit",
  );
  assert((await g.run(["push", origin, "main"], seed)).code === 0, "push main");
  assert(
    (await g.run(["symbolic-ref", "HEAD", "refs/heads/main"], origin)).code ===
      0,
    "set origin HEAD",
  );
  const work = join(dir, name);
  assert((await g.run(["clone", origin, work])).code === 0, "clone");
  await configure(work);
  return work;
}

async function seedCommitOnOrigin(
  dir: string,
  name: string,
  content: string,
): Promise<void> {
  const seed = join(dir, `${name}-seed`);
  const origin = join(dir, `${name}.git`);
  await Deno.writeTextFile(join(seed, "a.txt"), content);
  await g.run(["add", "."], seed);
  assert(
    (await g.run(["commit", "-m", "advance"], seed)).code === 0,
    "advance commit",
  );
  assert(
    (await g.run(["push", origin, "main"], seed)).code === 0,
    "advance push",
  );
}

function pathsFor(dir: string): ManifestPaths {
  return {
    root: dir,
    repositoriesDirectory: dir,
    worktreesDirectory: join(dir, "worktrees"),
    vaultDirectory: join(dir, "secrets"),
  };
}

Deno.test("defaultBranch resolves from origin/HEAD", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    assertEquals(await defaultBranch(g, work), "main");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("branchAb reports ahead/behind after advance", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await seedCommitOnOrigin(dir, "a", "two\n");
    assertEquals((await g.run(["fetch", "--prune"], work)).code, 0);
    assertEquals(await branchAb(g, work, "origin/main"), {
      ahead: 0,
      behind: 1,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update fast-forwards a clean default branch", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await seedCommitOnOrigin(dir, "a", "two\n");
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "a", url: "u", path: work }] },
      pathsFor(dir),
    );
    assertEquals(actions, [{ kind: "FAST_FORWARD", name: "a", commits: 1 }]);
    assertEquals(await isDirty(g, work), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update skips dirty repositories", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await Deno.writeTextFile(join(work, "a.txt"), "local change\n");
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "a", url: "u", path: work }] },
      pathsFor(dir),
    );
    assertEquals(actions, [
      { kind: "SKIP_DIRTY", name: "a", detail: "uncommitted changes" },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update skips feature-branch checkouts", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await g.run(["checkout", "-b", "feature-x"], work);
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "a", url: "u", path: work }] },
      pathsFor(dir),
    );
    assertEquals(actions[0].kind, "SKIP_FEATURE");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update reports CURRENT when already in sync", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "a", url: "u", path: work }] },
      pathsFor(dir),
    );
    assertEquals(actions, [{
      kind: "CURRENT",
      name: "a",
      detail: "origin/main",
    }]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("worktree add/list/remove round trip", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const worktreePath = join(dir, "worktrees", "a", "feature-x");
    assertEquals(
      (await addWorktree(g, work, worktreePath, "feature-x")).code,
      0,
    );

    const worktrees = await listWorktrees(g, work);
    const created = worktrees.find((w) =>
      w.path.replaceAll("\\", "/") === worktreePath.replaceAll("\\", "/")
    );
    assert(created, "worktree not found");
    assertEquals(created.branch, "feature-x");

    assertEquals((await removeWorktree(g, work, created.path)).code, 0);
    const after = await listWorktrees(g, work);
    assertEquals(
      after.find((w) =>
        w.path.replaceAll("\\", "/") === worktreePath.replaceAll("\\", "/")
      ),
      undefined,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update skips when default branch is checked out in a worktree", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    // Detach the base checkout, then check the default branch out in a linked worktree.
    assertEquals((await g.run(["checkout", "--detach"], work)).code, 0);
    const worktreePath = join(dir, "worktrees", "a", "main");
    assertEquals(
      (await g.run(["worktree", "add", worktreePath, "main"], work)).code,
      0,
    );
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "a", url: "u", path: work }] },
      pathsFor(dir),
    );
    assertEquals(actions, [
      {
        kind: "SKIP_FEATURE",
        name: "a",
        detail: "main checked out in a worktree",
      },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("wspace init clones missing repositories", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await makeRepoWithMain(dir, "b");
    await Deno.remove(join(dir, "b"), { recursive: true });
    const manifestPath = join(dir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        repositories: [
          { name: "a", url: "u", path: work },
          { name: "b", url: join(dir, "b.git"), path: join(dir, "b") },
        ],
      }),
    );
    const code = await run(["init", "--manifest", manifestPath]);
    assertEquals(code, 0);
    assertEquals(
      await exists(join(dir, "b", ".git")),
      true,
      "missing repo should be cloned",
    );
    assertEquals(
      await exists(join(dir, "b", "a.txt")),
      true,
      "cloned repo should contain seeded file",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("wspace check reports CLEAN via CLI", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const manifestPath = join(dir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({ repositories: [{ name: "a", url: "u", path: work }] }),
    );
    const code = await run(["check", "--json", "--manifest", manifestPath]);
    assertEquals(code, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repoStatus reports MISSING when path does not exist", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const rows = await collectStatus(
      g,
      { repositories: [{ name: "a", url: "u", path: join(dir, "nope") }] },
      pathsFor(dir),
    );
    assertEquals(rows[0].state, "MISSING");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repoStatus reports INVALID when path has no .git", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const empty = join(dir, "empty");
    await Deno.mkdir(empty, { recursive: true });
    const rows = await collectStatus(
      g,
      { repositories: [{ name: "a", url: "u", path: empty }] },
      pathsFor(dir),
    );
    assertEquals(rows[0].state, "INVALID");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("collectStatus flags unmanaged checkouts under repos dir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const reposDir = join(dir, "repos");
    await Deno.mkdir(reposDir, { recursive: true });
    const work = await makeRepoWithMain(dir, "a");
    const unmanaged = join(reposDir, "stray");
    await g.run(["clone", join(dir, "a.git"), unmanaged]);

    const rows = await collectStatus(
      g,
      { repositories: [{ name: "a", url: "u", path: work }] },
      { ...pathsFor(dir), repositoriesDirectory: reposDir },
    );
    const unmanagedRow = rows.find((r) => r.name === "(unmanaged) stray");
    assert(unmanagedRow, "unmanaged checkout should be reported");
    assertEquals(unmanagedRow.state, "CLEAN");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("defaultBranch returns undefined when origin/HEAD is missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await g.run(["remote", "set-head", "origin", "--delete"], work);
    assertEquals(await defaultBranch(g, work), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("collectStatus reports hasErrors for MISSING and INVALID", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const empty = join(dir, "empty");
    await Deno.mkdir(empty, { recursive: true });
    const rows = await collectStatus(
      g,
      {
        repositories: [
          { name: "missing", url: "u", path: join(dir, "nope") },
          { name: "invalid", url: "u", path: empty },
        ],
      },
      pathsFor(dir),
    );
    assertEquals(rows.map((r) => r.state).sort(), ["INVALID", "MISSING"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

export type { GitRunner };
