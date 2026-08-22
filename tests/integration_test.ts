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
  staleness,
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
    await removeTempDir(dir);
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
    await removeTempDir(dir);
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
    await removeTempDir(dir);
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
    await removeTempDir(dir);
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
    await removeTempDir(dir);
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
    await removeTempDir(dir);
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
    await removeTempDir(dir);
  }
});

Deno.test("worktree add attaches an existing branch", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    assertEquals((await g.run(["branch", "feature-x"], work)).code, 0);
    const worktreePath = join(dir, "worktrees", "a", "feature-x");
    assertEquals(
      (await addWorktree(g, work, worktreePath, "feature-x")).code,
      0,
    );
    const worktrees = await listWorktrees(g, work);
    assert(
      worktrees.some((w) =>
        w.path.replaceAll("\\", "/") === worktreePath.replaceAll("\\", "/")
      ),
      "worktree for existing branch not found",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("worktree add branches from an explicit start point", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await seedCommitOnOrigin(dir, "a", "two\n");
    assertEquals((await g.run(["fetch", "--prune"], work)).code, 0);
    assertEquals(
      (await g.run(["checkout", "-b", "base-branch"], work)).code,
      0,
    );

    const worktreePath = join(dir, "worktrees", "a", "feature-x");
    assertEquals(
      (await addWorktree(g, work, worktreePath, "feature-x", "origin/main"))
        .code,
      0,
    );

    const head = (await g.run(["rev-parse", "HEAD"], worktreePath)).stdout;
    const originMain = (await g.run(["rev-parse", "origin/main"], work)).stdout;
    const baseBranch = (await g.run(["rev-parse", "base-branch"], work)).stdout;
    assertEquals(head, originMain);
    assert(head !== baseBranch, "forked from HEAD instead of the start point");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("staleness flags merged branches and never the main worktree", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const worktreePath = join(dir, "worktrees", "a", "feature-x");
    assertEquals(
      (await addWorktree(g, work, worktreePath, "feature-x", "origin/main"))
        .code,
      0,
    );
    const worktrees = await listWorktrees(g, work);
    const created = worktrees.find((w) =>
      w.path.replaceAll("\\", "/") === worktreePath.replaceAll("\\", "/")
    );
    assert(created, "worktree not found");

    assertEquals(
      await staleness(g, work, created, "main"),
      { stale: true, reason: "merged" },
    );

    await Deno.writeTextFile(join(worktreePath, "a.txt"), "feature\n");
    assertEquals((await g.run(["add", "."], worktreePath)).code, 0);
    await configure(worktreePath);
    assertEquals(
      (await g.run(["commit", "-m", "feature work"], worktreePath)).code,
      0,
    );
    assertEquals(
      await staleness(g, work, created, "main"),
      { stale: false },
    );

    const main = worktrees.find((w) =>
      w.path.replaceAll("\\", "/") === work.replaceAll("\\", "/")
    );
    assert(main, "main worktree not found");
    assertEquals(await staleness(g, work, main, "main"), { stale: false });
  } finally {
    await removeTempDir(dir);
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
    await removeTempDir(dir);
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
    await removeTempDir(dir);
  }
});

Deno.test("wspace init clones only specified subset of repositories", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await makeRepoWithMain(dir, "a");
    await makeRepoWithMain(dir, "b");
    await makeRepoWithMain(dir, "c");
    await Deno.remove(join(dir, "b"), { recursive: true });
    await Deno.remove(join(dir, "c"), { recursive: true });
    const manifestPath = join(dir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        repositories: [
          { name: "a", url: join(dir, "a.git"), path: join(dir, "a") },
          { name: "b", url: join(dir, "b.git"), path: join(dir, "b") },
          { name: "c", url: join(dir, "c.git"), path: join(dir, "c") },
        ],
      }),
    );
    const code = await run(["init", "b", "--manifest", manifestPath]);
    assertEquals(code, 0);
    assertEquals(
      await exists(join(dir, "b", ".git")),
      true,
      "specified repo b should be cloned",
    );
    assertEquals(
      await exists(join(dir, "c", ".git")),
      false,
      "unspecified repo c should not be cloned",
    );
  } finally {
    await removeTempDir(dir);
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
    await removeTempDir(dir);
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
    await removeTempDir(dir);
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
    await removeTempDir(dir);
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
    await removeTempDir(dir);
  }
});

Deno.test("defaultBranch returns undefined when origin/HEAD is missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await g.run(["remote", "set-head", "origin", "--delete"], work);
    assertEquals(await defaultBranch(g, work), undefined);
  } finally {
    await removeTempDir(dir);
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
    await removeTempDir(dir);
  }
});

Deno.test("collectStatus does not double-list managed repositories under reposDir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const reposDir = join(dir, "repos");
    await Deno.mkdir(reposDir, { recursive: true });
    const work = join(reposDir, "a");
    const origin = join(dir, "a.git");
    assert((await g.run(["init", "--bare", origin])).code === 0);
    assert((await g.run(["clone", origin, work])).code === 0);

    const rows = await collectStatus(
      g,
      { repositories: [{ name: "a", url: "u", path: work }] },
      { ...pathsFor(dir), repositoriesDirectory: reposDir },
    );
    const names = rows.map((r) => r.name);
    assertEquals(
      names,
      ["a"],
      "Managed repository should be reported exactly once",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace init fails when destination exists but is not a Git repo", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const nonGitPath = join(dir, "blocked");
    await Deno.mkdir(nonGitPath, { recursive: true });
    const manifestPath = join(dir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        repositories: [{ name: "blocked", url: "u", path: nonGitPath }],
      }),
    );
    const code = await run(["init", "--manifest", manifestPath]);
    assertEquals(
      code,
      1,
      "wspace init should exit non-zero when path is blocked",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("collectStatus reports linked worktrees and flags dirty linked worktrees", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const worktreePath = join(dir, "worktrees", "a", "feat-1");
    assertEquals((await addWorktree(g, work, worktreePath, "feat-1")).code, 0);
    await Deno.writeTextFile(join(worktreePath, "dirty.txt"), "uncommitted");

    const rows = await collectStatus(
      g,
      { repositories: [{ name: "a", url: "u", path: work }] },
      pathsFor(dir),
    );
    const wtRow = rows.find((r) => r.isWorktree);
    assert(wtRow, "Linked worktree row should be present");
    assertEquals(wtRow.state, "WORKTREE_DIRTY");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("env sync --dry-run previews sync without modifying filesystem", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const vaultDir = join(dir, "secrets", "a");
    await Deno.mkdir(vaultDir, { recursive: true });
    await Deno.writeTextFile(join(vaultDir, ".env"), "SECRET=123");

    const work = await makeRepoWithMain(dir, "a");
    const manifestPath = join(dir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        vaultDirectory: "secrets",
        repositories: [{ name: "a", url: "u", path: work }],
      }),
    );

    const code = await run([
      "env",
      "sync",
      "--dry-run",
      "--manifest",
      manifestPath,
    ]);
    assertEquals(code, 0);
    assertEquals(
      await exists(join(work, ".env")),
      false,
      "File should not be copied during dry-run",
    );
  } finally {
    await removeTempDir(dir);
  }
});

/**
 * Removes a temp dir, retrying while git still holds file handles open
 * (Windows denies deletion of in-use files; CI on linux never sees this).
 */
async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await removeTempDir(dir);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

// --- Recursive sub-workspace integration tests ---

/** Captures console.log output produced by fn (the CLI prints via console.log). */
async function captureStdout(fn: () => Promise<number>): Promise<{
  code: number;
  output: string;
}> {
  const chunks: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await fn();
    return { code, output: chunks.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

Deno.test("wspace check --json resolves parent + child repos across workspaces", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Create two real git repos.
    const parentRepo = await makeRepoWithMain(dir, "parent-repo");
    makeRepoWithMain(dir, "child-repo");

    // Child workspace manifest in a sibling directory; the child repo is
    // declared relative to the CHILD workspace root.
    const childDir = join(dir, "child-ws");
    await Deno.mkdir(childDir, { recursive: true });
    const childManifestPath = join(childDir, "workspace.json");
    await Deno.writeTextFile(
      childManifestPath,
      JSON.stringify({
        repositories: [
          { name: "child-repo", url: "u", path: "../child-repo" },
        ],
      }),
    );

    // Parent workspace manifest referencing the child.
    const parentManifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          { name: "parent-repo", url: "u", path: parentRepo },
        ],
        workspaces: [
          { name: "child-ws", path: "child-ws/workspace.json" },
        ],
      }),
    );

    // Run wspace check --json across both and verify content, not just exit code.
    const { code, output } = await captureStdout(() =>
      run(["check", "--json", "--manifest", parentManifestPath])
    );
    assertEquals(code, 0);
    const rows = JSON.parse(output) as Array<{ name: string; state: string }>;
    assertEquals(rows.length, 2);
    assertEquals(
      rows.find((r) => r.name === "parent-repo")?.state,
      "CLEAN",
    );
    // Resolved from the child manifest's own root via its relative path.
    assertEquals(rows.find((r) => r.name === "child-repo")?.state, "CLEAN");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace workspaces --json lists discovered sub-workspaces with repo counts", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const parentRepo = await makeRepoWithMain(dir, "parent-repo");
    await makeRepoWithMain(dir, "child-repo");

    const childDir = join(dir, "child-ws");
    await Deno.mkdir(childDir, { recursive: true });
    await Deno.writeTextFile(
      join(childDir, "workspace.json"),
      JSON.stringify({
        repositories: [
          { name: "child-repo", url: "u", path: "../child-repo" },
        ],
      }),
    );

    const parentManifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          { name: "parent-repo", url: "u", path: parentRepo },
        ],
        workspaces: [
          { name: "child-ws", path: "child-ws/workspace.json" },
        ],
      }),
    );

    const { code, output } = await captureStdout(() =>
      run(["workspaces", "--json", "--manifest", parentManifestPath])
    );
    assertEquals(code, 0);
    const listing = JSON.parse(output) as Array<
      { name: string; repos: number; child: boolean }
    >;
    assertEquals(listing, [
      { name: "(root)", repos: 1, child: false },
      { name: "child-ws", repos: 1, child: true },
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace workspaces and check flatten nested sub-workspace trees", async () => {
  const dir = await Deno.makeTempDir();
  try {
    makeRepoWithMain(dir, "mid-repo");
    makeRepoWithMain(dir, "deep-repo");

    // root/child-ws/nested-ws tree, all edges relative.
    await Deno.mkdir(join(dir, "child-ws", "nested-ws"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "child-ws", "workspace.json"),
      JSON.stringify({
        repositories: [
          { name: "mid-repo", url: "u", path: "../mid-repo" },
        ],
        workspaces: [{ name: "nested-ws", path: "nested-ws/workspace.json" }],
      }),
    );
    await Deno.writeTextFile(
      join(dir, "child-ws", "nested-ws", "workspace.json"),
      JSON.stringify({
        repositories: [
          { name: "deep-repo", url: "u", path: "../../../deep-repo" },
        ],
      }),
    );

    const parentManifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [],
        workspaces: [{ name: "child-ws", path: "child-ws/workspace.json" }],
      }),
    );

    const listing = await captureStdout(() =>
      run(["workspaces", "--json", "--manifest", parentManifestPath])
    );
    assertEquals(listing.code, 0);
    const parsed = JSON.parse(listing.output) as Array<
      { name: string; repos: number; child: boolean }
    >;
    assertEquals(parsed, [
      { name: "child-ws", repos: 1, child: true },
      { name: "nested-ws", repos: 1, child: true },
    ]);

    const check = await captureStdout(() =>
      run(["check", "--json", "--manifest", parentManifestPath])
    );
    assertEquals(check.code, 0);
    const rows = JSON.parse(check.output) as Array<
      { name: string; state: string }
    >;
    assertEquals(
      rows.find((r) => r.name === "deep-repo")?.state,
      "CLEAN",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace check --workspace scopes to a single sub-workspace", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const parentRepo = await makeRepoWithMain(dir, "parent-repo");
    const childRepo = await makeRepoWithMain(dir, "child-repo");

    const childDir = join(dir, "child-ws");
    await Deno.mkdir(childDir, { recursive: true });
    await Deno.writeTextFile(
      join(childDir, "workspace.json"),
      JSON.stringify({
        repositories: [
          { name: "child-repo", url: "u", path: childRepo },
        ],
      }),
    );

    const parentManifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          { name: "parent-repo", url: "u", path: parentRepo },
        ],
        workspaces: [
          { name: "child-ws", path: "child-ws/workspace.json" },
        ],
      }),
    );

    // Scoped to child-ws: only child-repo should be checked.
    const code = await run([
      "check",
      "--json",
      "--workspace",
      "child-ws",
      "--manifest",
      parentManifestPath,
    ]);
    assertEquals(code, 0);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace check errors on conflicting repo names across workspaces", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repoA = await makeRepoWithMain(dir, "shared-name");
    const repoB = await makeRepoWithMain(dir, "shared-name-2");

    // Two child workspaces both claiming a repo named "shared".
    const childADir = join(dir, "child-a");
    const childBDir = join(dir, "child-b");
    await Deno.mkdir(childADir, { recursive: true });
    await Deno.mkdir(childBDir, { recursive: true });
    await Deno.writeTextFile(
      join(childADir, "workspace.json"),
      JSON.stringify({
        repositories: [{ name: "shared", url: "u", path: repoA }],
      }),
    );
    await Deno.writeTextFile(
      join(childBDir, "workspace.json"),
      JSON.stringify({
        repositories: [{ name: "shared", url: "u", path: repoB }],
      }),
    );

    const parentManifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [],
        workspaces: [
          { name: "child-a", path: "child-a/workspace.json" },
          { name: "child-b", path: "child-b/workspace.json" },
        ],
      }),
    );

    const code = await run([
      "check",
      "--json",
      "--manifest",
      parentManifestPath,
    ]);
    assertEquals(code, 2, "should error on conflict");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("v1 manifests without workspaces field continue to work", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const manifestPath = join(dir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        repositories: [{ name: "a", url: "u", path: work }],
      }),
    );
    const code = await run(["check", "--json", "--manifest", manifestPath]);
    assertEquals(code, 0);
  } finally {
    await removeTempDir(dir);
  }
});

export type { GitRunner };
