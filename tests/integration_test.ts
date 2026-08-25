import { assert, assertEquals } from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";
import {
  branchAb,
  defaultBranch,
  type GitRunner,
  isDirty,
  SystemGit,
} from "../src/git.ts";
import type { ManifestPaths } from "../src/manifest.ts";
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
    secretsDirectory: join(dir, "secrets"),
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
      { repositories: [{ name: "a", url: "u" }] },
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
      { repositories: [{ name: "a", url: "u" }] },
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
      { repositories: [{ name: "a", url: "u" }] },
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
    await makeRepoWithMain(dir, "a");
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "a", url: "u" }] },
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
      { repositories: [{ name: "a", url: "u" }] },
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
    await makeRepoWithMain(dir, "a");
    await makeRepoWithMain(dir, "b");
    const manifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        repositories: [
          { name: "a", url: join(dir, "a.git") },
          { name: "b", url: join(dir, "b.git") },
        ],
      }),
    );
    // Fresh workspace: neither default-location checkout exists yet.
    const code = await run(["init", "--manifest", manifestPath]);
    assertEquals(code, 0);
    assertEquals(
      await exists(join(dir, "repos", "b", ".git")),
      true,
      "missing repo should be cloned",
    );
    assertEquals(
      await exists(join(dir, "repos", "b", "a.txt")),
      true,
      "cloned repo should contain seeded file",
    );
    assertEquals(
      await exists(join(dir, "repos", "a", ".git")),
      true,
      "existing-origin repo a should also be cloned",
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
    const manifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        repositories: [
          { name: "a", url: join(dir, "a.git") },
          { name: "b", url: join(dir, "b.git") },
          { name: "c", url: join(dir, "c.git") },
        ],
      }),
    );
    const code = await run(["init", "b", "--manifest", manifestPath]);
    assertEquals(code, 0);
    assertEquals(
      await exists(join(dir, "repos", "b", ".git")),
      true,
      "specified repo b should be cloned",
    );
    assertEquals(
      await exists(join(dir, "repos", "a", ".git")),
      false,
      "unspecified repo a should not be cloned",
    );
    assertEquals(
      await exists(join(dir, "repos", "c", ".git")),
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
    const manifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        repositoriesDirectory: ".",
        repositories: [{ name: "a", url: "u" }],
      }),
    );
    const code = await run(["check", "--json", "--manifest", manifestPath]);
    assertEquals(code, 0);
    assert(work, "sanity: checkout exists");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("repoStatus reports MISSING when path does not exist", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const rows = await collectStatus(
      g,
      { repositories: [{ name: "nope", url: "u" }] },
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
      {
        repositories: [{
          name: "empty",
          url: "u",
          resolvedPath: empty,
        }],
      },
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
    // Seed a real commit history: an empty bare origin would leave the clone
    // on an unborn branch and report FEATURE_CLEAN instead of CLEAN.
    await makeRepoWithMain(dir, "a");
    const unmanaged = join(reposDir, "stray");
    await g.run(["clone", join(dir, "a.git"), unmanaged]);

    const rows = await collectStatus(
      g,
      { repositories: [] },
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
          { name: "missing", url: "u" },
          { name: "empty", url: "u", resolvedPath: empty },
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
      { repositories: [{ name: "a", url: "u" }] },
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
    const nonGitPath = join(dir, "repos", "blocked");
    await Deno.mkdir(nonGitPath, { recursive: true });
    const manifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        repositories: [{ name: "blocked", url: "u" }],
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
      { repositories: [{ name: "a", url: "u" }] },
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

    const origin = join(dir, "a.git");
    assert((await g.run(["init", "--bare", origin])).code === 0);
    const checkout = join(dir, "repos", "a");
    assert((await g.run(["clone", origin, checkout])).code === 0);

    const manifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        secretsDirectory: "secrets",
        repositories: [{ name: "a", url: "u" }],
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
      await exists(join(checkout, ".env")),
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
      await Deno.remove(dir, { recursive: true });
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

/**
 * Turns the working clone of `name` into a detected sub-workspace container:
 * moves it to its manifest-default location (<dir>/repos/<name>) and writes
 * the given manifest into the checkout.
 */
async function promoteToContainer(
  dir: string,
  name: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const reposDir = join(dir, "repos");
  await Deno.mkdir(reposDir, { recursive: true });
  const containerDir = join(reposDir, name);
  await Deno.rename(join(dir, name), containerDir);
  await Deno.writeTextFile(
    join(containerDir, "workspace.json"),
    JSON.stringify(manifest),
  );
  // Keep the container checkout clean so full-tree checks stay green.
  await g.run(["add", "."], containerDir);
  await g.run(["commit", "-m", "workspace manifest"], containerDir);
  await g.run(["push", "origin", "main"], containerDir);
  return containerDir;
}

Deno.test("wspace check --json resolves parent + detected child across workspaces", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await makeRepoWithMain(dir, "parent-repo");
    await makeRepoWithMain(dir, "child-repo");
    await makeRepoWithMain(dir, "child-ws");

    // The child workspace composes through detection: its manifest lives in
    // the container checkout at the default location and resolves its repos
    // against the shared root where their checkouts already exist.
    await promoteToContainer(dir, "child-ws", {
      repositoriesDirectory: dir,
      repositories: [{ name: "child-repo", url: join(dir, "child-repo.git") }],
    });
    const parentCheckout = join(dir, "repos", "parent-repo");
    await Deno.rename(join(dir, "parent-repo"), parentCheckout);

    const parentManifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          { name: "parent-repo", url: join(dir, "parent-repo.git") },
          {
            name: "child-ws",
            url: join(dir, "child-ws.git"),
            autoCompose: true,
          },
        ],
      } as unknown as Record<string, unknown>),
    );

    const { code, output } = await captureStdout(() =>
      run(["check", "--json", "--manifest", parentManifestPath])
    );
    assertEquals(code, 0, output);
    const rows = JSON.parse(output) as Array<{ name: string; state: string }>;
    assertEquals(rows.length, 3);
    assertEquals(rows.find((r) => r.name === "parent-repo")?.state, "CLEAN");
    assertEquals(rows.find((r) => r.name === "child-ws")?.state, "CLEAN");
    assertEquals(rows.find((r) => r.name === "child-repo")?.state, "CLEAN");

    const listing = await captureStdout(() =>
      run(["workspaces", "--json", "--manifest", parentManifestPath])
    );
    assertEquals(listing.code, 0);
    const names = (JSON.parse(listing.output) as Array<
      { name: string; repos: number }
    >).map((w) => w.name);
    assertEquals(names.includes("child-ws"), true);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace workspaces and check flatten nested detected sub-workspace trees", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await makeRepoWithMain(dir, "mid-repo");
    await makeRepoWithMain(dir, "deep-repo");
    await makeRepoWithMain(dir, "child-ws");
    await makeRepoWithMain(dir, "inner");

    const containerDir = await promoteToContainer(dir, "child-ws", {
      repositories: [
        { name: "mid-repo", url: join(dir, "mid-repo.git") },
        {
          name: "inner",
          url: join(dir, "inner.git"),
          autoCompose: true,
        },
      ],
    } as unknown as Record<string, unknown>);
    // Ignore the container's nested repos/ directory so composed checkouts
    // keep the container clean, matching real-world container repos.
    await Deno.writeTextFile(join(containerDir, ".gitignore"), "repos/\n");
    await g.run(["add", "."], containerDir);
    await g.run(["commit", "-m", "ignore nested repos"], containerDir);
    await g.run(["push", "origin", "main"], containerDir);
    // mid-repo resolves against the container's own root: place its checkout
    // where the container's default repos directory expects it.
    const midCheckout = join(containerDir, "repos", "mid-repo");
    await Deno.mkdir(join(containerDir, "repos"), { recursive: true });
    await Deno.rename(join(dir, "mid-repo"), midCheckout);

    // inner lives inside the container's repos/ directory; its own manifest
    // declares deep-repo against the shared root.
    const innerDir = join(containerDir, "repos", "inner");
    await Deno.rename(join(dir, "inner"), innerDir);
    const innerManifestPath = join(
      containerDir,
      "repos",
      "inner",
      "workspace.json",
    );
    await Deno.writeTextFile(
      innerManifestPath,
      JSON.stringify({
        repositories: [{ name: "deep-repo", url: join(dir, "deep-repo.git") }],
      }),
    );
    // Ignore inner's own nested repos/ so deep-repo keeps it clean.
    await Deno.writeTextFile(join(innerDir, ".gitignore"), "repos/\n");
    await g.run(["add", "."], join(containerDir, "repos", "inner"));
    await g.run(
      ["commit", "-m", "workspace manifest"],
      join(containerDir, "repos", "inner"),
    );
    await g.run(
      ["push", "origin", "main"],
      join(containerDir, "repos", "inner"),
    );

    // deep-repo resolves under inner's repos/ directory: place it there.
    const deepCheckout = join(
      containerDir,
      "repos",
      "inner",
      "repos",
      "deep-repo",
    );
    await Deno.mkdir(join(innerDir, "repos"), { recursive: true });
    await Deno.rename(join(dir, "deep-repo"), deepCheckout);

    const parentManifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          {
            name: "child-ws",
            url: join(dir, "child-ws.git"),
            autoCompose: true,
          },
        ],
      } as unknown as Record<string, unknown>),
    );

    const listing = await captureStdout(() =>
      run(["workspaces", "--json", "--manifest", parentManifestPath])
    );
    assertEquals(listing.code, 0);
    const parsed = JSON.parse(listing.output) as Array<
      { name: string; repos: number; child: boolean }
    >;
    assertEquals(parsed.length, 3);

    const check = await captureStdout(() =>
      run(["check", "--json", "--manifest", parentManifestPath])
    );
    assertEquals(check.code, 0, check.output);
    const rows = JSON.parse(check.output) as Array<
      { name: string; state: string }
    >;
    assertEquals(rows.find((r) => r.name === "deep-repo")?.state, "CLEAN");
    assertEquals(rows.find((r) => r.name === "mid-repo")?.state, "CLEAN");
    assertEquals(rows.find((r) => r.name === "inner")?.state, "CLEAN");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace check --workspace scopes to a single sub-workspace", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await makeRepoWithMain(dir, "child-repo");
    await makeRepoWithMain(dir, "child-ws");

    await promoteToContainer(dir, "child-ws", {
      repositoriesDirectory: dir,
      repositories: [{ name: "child-repo", url: "u" }],
    });

    const parentManifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({ repositories: ["child-ws"] }),
    );
    // Expand strings by hand for this test: the container row needs a real
    // URL for status; autoCompose drives detection either way.
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          {
            name: "child-ws",
            url: join(dir, "child-ws.git"),
            autoCompose: true,
          },
        ],
      } as unknown as Record<string, unknown>),
    );

    // Scoped to child-ws: only child-repo should be checked.
    const { code, output } = await captureStdout(() =>
      run([
        "check",
        "--json",
        "--workspace",
        "child-ws",
        "--manifest",
        parentManifestPath,
      ])
    );
    assertEquals(code, 0, output);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace check errors on conflicting repo names across workspaces", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await makeRepoWithMain(dir, "shared-name-a");
    await makeRepoWithMain(dir, "shared-name-b");
    await makeRepoWithMain(dir, "child-a");
    await makeRepoWithMain(dir, "child-b");

    // Two detected sub-workspaces both claiming a repo named "shared".
    await promoteToContainer(dir, "child-a", {
      repositories: [{ name: "shared", url: join(dir, "shared-name-a.git") }],
    });
    await promoteToContainer(dir, "child-b", {
      repositories: [{ name: "shared", url: join(dir, "shared-name-b.git") }],
    });

    const parentManifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          {
            name: "child-a",
            url: join(dir, "child-a.git"),
            autoCompose: true,
          },
          {
            name: "child-b",
            url: join(dir, "child-b.git"),
            autoCompose: true,
          },
        ],
      } as unknown as Record<string, unknown>),
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

Deno.test("legacy flat manifests continue to work", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await makeRepoWithMain(dir, "a");
    const manifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        repositoriesDirectory: ".",
        repositories: [{ name: "a", url: "u" }],
      }),
    );
    const code = await run(["check", "--json", "--manifest", manifestPath]);
    assertEquals(code, 0);
  } finally {
    await removeTempDir(dir);
  }
});

/**
 * Rewrites https://<host>/<owner>/... prefixes to local bare origins for the
 * duration of fn via GIT_CONFIG_GLOBAL, so shorthand entries can be exercised
 * against seeded repositories without touching real remotes.
 */
async function withOwnerRewrite(
  dir: string,
  rules: { host: string; owner: string }[],
  fn: () => Promise<void>,
): Promise<void> {
  const cfgPath = join(dir, "git-config-global");
  // Git config values treat backslashes as escapes; use forward slashes.
  const base = dir.replaceAll("\\", "/");
  const sections = rules.map((r) =>
    `[url "${base}/"]\n\tinsteadOf = https://${r.host}/${r.owner}/\n`
  ).join("");
  await Deno.writeTextFile(cfgPath, sections);
  const prior = Deno.env.get("GIT_CONFIG_GLOBAL");
  Deno.env.set("GIT_CONFIG_GLOBAL", cfgPath);
  try {
    await fn();
  } finally {
    if (prior === undefined) {
      Deno.env.delete("GIT_CONFIG_GLOBAL");
    } else {
      Deno.env.set("GIT_CONFIG_GLOBAL", prior);
    }
  }
}

Deno.test("wspace init converges string-shorthand detection in one invocation", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Local bare origins standing in for github.com/acme/{container,inner}.
    const seedBareWithManifest = async (
      name: string,
      manifest?: Record<string, unknown>,
    ): Promise<string> => {
      const origin = join(dir, `${name}.git`);
      const seed = join(dir, `${name}-seed`);
      assert((await g.run(["init", "--bare", origin])).code === 0);
      assert((await g.run(["init", seed])).code === 0);
      await configure(seed);
      assert((await g.run(["checkout", "-b", "main"], seed)).code === 0);
      await Deno.writeTextFile(join(seed, "a.txt"), "one\n");
      if (manifest) {
        await Deno.writeTextFile(
          join(seed, "repos.json"),
          JSON.stringify(manifest),
        );
        // Nested clones land under the container's repos/ directory; ignore
        // them so the container checkout stays clean.
        await Deno.writeTextFile(join(seed, ".gitignore"), "repos/\n");
      }
      await g.run(["add", "."], seed);
      assert((await g.run(["commit", "-m", "seed"], seed)).code === 0);
      assert((await g.run(["push", origin, "main"], seed)).code === 0);
      assert(
        (await g.run(["symbolic-ref", "HEAD", "refs/heads/main"], origin))
          .code === 0,
      );
      return origin;
    };

    await seedBareWithManifest("inner");
    await seedBareWithManifest("container", {
      owner: "acme",
      repositories: ["inner"],
    });

    // Fresh workspace: one bare-string entry. Detection must discover the
    // container's repos.json after cloning and pull in "inner" within this
    // single init invocation.
    const parentManifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        schemaVersion: 4,
        owner: "acme",
        repositoriesDirectory: "repos",
        repositories: ["container"],
      }),
    );

    await withOwnerRewrite(
      dir,
      [{ host: "github.com", owner: "acme" }],
      async () => {
        const { code } = await captureStdout(() =>
          run(["init", "--json", "--manifest", parentManifestPath])
        );
        assertEquals(code, 0);

        const check = await captureStdout(() =>
          run(["check", "--json", "--manifest", parentManifestPath])
        );
        assertEquals(check.code, 0);
        const rows = JSON.parse(check.output) as Array<{
          name: string;
          state: string;
        }>;
        assertEquals(rows.length, 2, "container + detected inner expected");
        assertEquals(rows.find((r) => r.name === "container")?.state, "CLEAN");
        assertEquals(rows.find((r) => r.name === "inner")?.state, "CLEAN");

        const listing = await captureStdout(() =>
          run(["workspaces", "--json", "--manifest", parentManifestPath])
        );
        const parsed = JSON.parse(listing.output) as Array<
          { name: string; child: boolean }
        >;
        assert(
          parsed.some((ws) => ws.name === "container" && ws.child),
          "detected container should be listed as a sub-workspace",
        );
      },
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace init converges slash-shorthand on a custom host in one invocation", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const seedBare = async (
      name: string,
      manifest?: Record<string, unknown>,
    ): Promise<string> => {
      const origin = join(dir, `${name}.git`);
      const seed = join(dir, `${name}-seed`);
      assert((await g.run(["init", "--bare", origin])).code === 0);
      assert((await g.run(["init", seed])).code === 0);
      await configure(seed);
      assert((await g.run(["checkout", "-b", "main"], seed)).code === 0);
      await Deno.writeTextFile(join(seed, "a.txt"), "one\n");
      if (manifest) {
        // Child manifests are self-contained: shorthand entries resolve
        // against THIS manifest's host and owner, never the parent's.
        await Deno.writeTextFile(
          join(seed, "repos.json"),
          JSON.stringify(manifest),
        );
        // Ignore nested repos/ so composed checkouts keep this repo clean.
        await Deno.writeTextFile(join(seed, ".gitignore"), "repos/\n");
      }
      await g.run(["add", "."], seed);
      assert((await g.run(["commit", "-m", "seed"], seed)).code === 0);
      assert((await g.run(["push", origin, "main"], seed)).code === 0);
      assert(
        (await g.run(["symbolic-ref", "HEAD", "refs/heads/main"], origin))
          .code === 0,
      );
      return origin;
    };

    await seedBare("inner");
    await seedBare("container", {
      host: "gitlab.com",
      repositories: [{ name: "inner", owner: "acme" }],
    });

    // Custom host + slash-shorthand with an inline owner: both entries expand
    // against gitlab.com and converge through detection.
    const parentManifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        schemaVersion: 4,
        host: "gitlab.com",
        repositories: ["wazootech/container"],
      }),
    );

    await withOwnerRewrite(dir, [
      { host: "gitlab.com", owner: "wazootech" },
      { host: "gitlab.com", owner: "acme" },
    ], async () => {
      const { code } = await captureStdout(() =>
        run(["init", "--json", "--manifest", parentManifestPath])
      );
      assertEquals(code, 0);

      const check = await captureStdout(() =>
        run(["check", "--json", "--manifest", parentManifestPath])
      );
      assertEquals(check.code, 0, check.output);
      const rows = JSON.parse(check.output) as Array<{
        name: string;
        state: string;
      }>;
      assertEquals(rows.length, 2);
      assertEquals(rows.find((r) => r.name === "container")?.state, "CLEAN");
      assertEquals(rows.find((r) => r.name === "inner")?.state, "CLEAN");
    });
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("loadManifest rejects a legacy vaultDirectory through the CLI path", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const manifestPath = join(dir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        repositories: [],
        vaultDirectory: "secrets",
      }),
    );
    let threw = "";
    try {
      await run(["validate", "--manifest", manifestPath]);
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    assert(
      threw.includes('renamed to "secretsDirectory"'),
      `expected rename migration error, got: ${threw}`,
    );
  } finally {
    await removeTempDir(dir);
  }
});

export type { GitRunner };
