import { assert, assertEquals } from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";
import {
  branchAb,
  defaultBranch,
  type GitRunner,
  isDirty,
  SystemGit,
} from "@/git.ts";
import { loadManifest, type ManifestPaths } from "@/manifest.ts";
import { run } from "@/cli.ts";
import { collectStatus } from "@/status.ts";
import { runUpdate } from "@/update.ts";
import {
  addWorktree,
  listWorktrees,
  removeWorktree,
  staleness,
} from "@/worktrees.ts";

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
  const p: ManifestPaths = {
    root: dir,
    repositoriesDirectory: dir,
    worktreesDirectory: join(dir, "worktrees"),
    secretsDirectory: join(dir, "secrets"),
  };
  return p;
}

/** Capture stdout output from console.log calls. */
function captureStdout() {
  let output = "";
  const original = console.log;
  // deno-lint-ignore no-explicit-any
  console.log = (...args: any[]) => {
    output += args.map(String).join(" ") + "\n";
  };
  return {
    stop() {
      console.log = original;
    },
    output() {
      return output;
    },
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

Deno.test("wspace install clones missing repositories", async () => {
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
    const code = await run(["install", "--manifest", manifestPath]);
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

Deno.test("wspace install clones only specified subset of repositories", async () => {
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
    const code = await run(["install", "b", "--manifest", manifestPath]);
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

Deno.test("wspace install fails when destination exists but is not a Git repo", async () => {
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
    const code = await run(["install", "--manifest", manifestPath]);
    assertEquals(
      code,
      1,
      "wspace install should exit non-zero when path is blocked",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace init scaffolds a manifest and standard directories", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const manifestPath = join(dir, "workspace.json");
    const code = await run([
      "init",
      "--host",
      "github.com",
      "--owner",
      "acme",
      "api",
      "other/tool",
      "--manifest",
      manifestPath,
    ]);
    assertEquals(code, 0);
    const doc = JSON.parse(await Deno.readTextFile(manifestPath)) as {
      schemaVersion: number;
      host?: string;
      owner?: string;
      repositories: string[];
    };
    assertEquals(doc.schemaVersion, 4);
    assertEquals(doc.host, "github.com");
    assertEquals(doc.owner, "acme");
    assertEquals(doc.repositories, ["api", "other/tool"]);
    assert(await exists(join(dir, "repos")), "repos/ should be created");
    assert(
      await exists(join(dir, "worktrees")),
      "worktrees/ should be created",
    );
    assert(await exists(join(dir, "secrets")), "secrets/ should be created");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace init refuses when a manifest already exists", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const manifestPath = join(dir, "workspace.json");
    const original = JSON.stringify({
      repositories: [{ name: "a", url: "u" }],
    });
    await Deno.writeTextFile(manifestPath, original);
    const code = await run([
      "init",
      "--owner",
      "acme",
      "b",
      "--manifest",
      manifestPath,
    ]);
    assertEquals(code, 2);
    assertEquals(
      await Deno.readTextFile(manifestPath),
      original,
      "existing manifest must remain untouched",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace init fails closed on invalid seeds without writing anything", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const missingOwner = await run([
      "init",
      "--manifest",
      join(dir, "workspace.json"),
      "orphan",
    ]);
    assertEquals(missingOwner, 2, "shorthand without owner must fail");
    assertEquals(
      await exists(join(dir, "workspace.json")),
      false,
      "failed scaffold must not write a manifest",
    );

    const dup = await run([
      "init",
      "--owner",
      "acme",
      "a",
      "a",
      "--manifest",
      join(dir, "repos.json"),
    ]);
    assertEquals(dup, 2, "duplicate seeded names must fail");
    assertEquals(
      await exists(join(dir, "repos.json")),
      false,
      "failed scaffold must not write a manifest",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("init-scaffolded manifest feeds wspace install end-to-end", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Local bare origin standing in for github.com/acme/api.
    const origin = join(dir, "api.git");
    const seed = join(dir, "api-seed");
    assert((await g.run(["init", "--bare", origin])).code === 0);
    assert((await g.run(["init", seed])).code === 0);
    await configure(seed);
    assert((await g.run(["checkout", "-b", "main"], seed)).code === 0);
    await Deno.writeTextFile(join(seed, "a.txt"), "one\n");
    await g.run(["add", "."], seed);
    assert((await g.run(["commit", "-m", "seed"], seed)).code === 0);
    assert((await g.run(["push", origin, "main"], seed)).code === 0);
    assert(
      (await g.run(["symbolic-ref", "HEAD", "refs/heads/main"], origin))
        .code === 0,
    );

    const manifestPath = join(dir, "workspace.json");
    await withOwnerRewrite(
      dir,
      [{ host: "github.com", owner: "acme" }],
      async () => {
        assertEquals(
          await run([
            "init",
            "--owner",
            "acme",
            "api",
            "--manifest",
            manifestPath,
          ]),
          0,
          "scaffold should succeed in an empty directory",
        );
        assertEquals(
          await run(["install", "--manifest", manifestPath]),
          0,
          "install should clone from the scaffolded shorthand entry",
        );
      },
    );
    assert(
      await exists(join(dir, "repos", "api", ".git")),
      "scaffolded shorthand should install from the rewritten remote",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace add appends shorthand entries without touching remotes", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const manifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 4,
        host: "gitlab.com",
        owner: "acme",
        repositories: [{ name: "existing", url: "https://x/existing.git" }],
      }),
    );
    assertEquals(
      await run(["add", "acme/api", "--manifest", manifestPath]),
      0,
      "shorthand with inline owner should skip remote checks",
    );
    assertEquals(
      await run(["add", "tool", "--manifest", manifestPath]),
      0,
      "bare shorthand should expand against host without remote checks",
    );
    const { repositories } = await loadManifest(manifestPath);
    assertEquals(
      repositories.map((r) => r.name),
      ["existing", "api", "tool"],
    );
    assertEquals(repositories[2].url, "https://gitlab.com/acme/tool");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace add --url derives the name from the URL basename", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const manifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 4, repositories: [] }),
    );
    assertEquals(
      await run([
        "add",
        "--url",
        "https://gitlab.com/acme/memsdk.git",
        "--manifest",
        manifestPath,
      ]),
      0,
    );
    let { repositories } = await loadManifest(manifestPath);
    assertEquals(repositories[0].name, "memsdk");

    assertEquals(
      await run([
        "add",
        "aliased",
        "--url",
        "https://gitlab.com/acme/memsdk.git",
        "--manifest",
        manifestPath,
      ]),
      0,
      "positional name should override the derived basename",
    );
    ({ repositories } = await loadManifest(manifestPath));
    assertEquals(repositories[1].name, "aliased");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace add rejects duplicates and missing manifests fail closed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const missing = join(dir, "workspace.json");
    assertEquals(
      await run(["add", "api", "--manifest", missing]),
      2,
      "adding against a missing manifest should exit 2",
    );

    const manifestPath = join(dir, "workspace.json");
    const original = JSON.stringify({
      schemaVersion: 4,
      host: "gitlab.com",
      repositories: ["api"],
    });
    await Deno.writeTextFile(manifestPath, original);
    assertEquals(
      await run(["add", "other/api", "--manifest", manifestPath]),
      2,
      "duplicate local name should exit 2",
    );
    assertEquals(
      await Deno.readTextFile(manifestPath),
      original,
      "failed add must not touch the manifest",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace remove deletes the entry but keeps the checkout on disk", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await makeRepoWithMain(dir, "a");
    const manifestPath = join(dir, "workspace.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        repositoriesDirectory: ".",
        repositories: [{ name: "a", url: join(dir, "a.git") }],
      }),
    );
    assertEquals(
      await run(["remove", "a", "--manifest", manifestPath]),
      0,
    );
    const { repositories } = await loadManifest(manifestPath);
    assertEquals(repositories.length, 0);
    assertEquals(
      await exists(join(dir, "a")),
      true,
      "local checkout must remain on disk after remove",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace remove fails on unknown names and dry-run writes nothing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const manifestPath = join(dir, "workspace.json");
    const original = JSON.stringify({
      schemaVersion: 4,
      host: "gitlab.com",
      owner: "acme",
      repositories: ["api"],
    });
    await Deno.writeTextFile(manifestPath, original);

    assertEquals(
      await run(["remove", "nope", "--manifest", manifestPath]),
      2,
      "unknown repository should exit 2",
    );
    assertEquals(
      await Deno.readTextFile(manifestPath),
      original,
    );

    assertEquals(
      await run(["remove", "api", "--dry-run", "--manifest", manifestPath]),
      0,
      "dry-run should succeed",
    );
    assertEquals(
      await Deno.readTextFile(manifestPath),
      original,
      "dry-run must not write the manifest",
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

Deno.test("wspace path finds repo in repos/", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const reposDir = join(dir, "repos");
    await Deno.mkdir(join(reposDir, "my-api"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "workspace.json"),
      JSON.stringify({
        schemaVersion: 4,
        owner: "acme",
        repositories: ["my-api"],
        workspaceRoot: dir,
      }),
    );
    const stdout = captureStdout();
    const code = await run([
      "path",
      "my-api",
      "--manifest",
      join(dir, "workspace.json"),
    ]);
    stdout.stop();
    assertEquals(code, 0);
    assertEquals(stdout.output().trim(), join(reposDir, "my-api"));
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace path finds worktree in worktrees/", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const wtDir = join(dir, "worktrees", "api", "split-commands");
    await Deno.mkdir(wtDir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "workspace.json"),
      JSON.stringify({
        schemaVersion: 4,
        owner: "acme",
        repositories: ["api"],
        workspaceRoot: dir,
      }),
    );
    const stdout = captureStdout();
    const code = await run([
      "path",
      "split-commands",
      "--manifest",
      join(dir, "workspace.json"),
    ]);
    stdout.stop();
    assertEquals(code, 0);
    assertEquals(stdout.output().trim(), wtDir);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace path returns exit 1 for no match", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "repos", "a"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "workspace.json"),
      JSON.stringify({
        schemaVersion: 4,
        owner: "acme",
        repositories: ["a"],
        workspaceRoot: dir,
      }),
    );
    const code = await run([
      "path",
      "nonexistent",
      "--manifest",
      join(dir, "workspace.json"),
    ]);
    assertEquals(code, 1);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace path returns exit 1 for ambiguous query", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "repos", "api"), { recursive: true });
    await Deno.mkdir(join(dir, "repos", "api-client"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "workspace.json"),
      JSON.stringify({
        schemaVersion: 4,
        owner: "acme",
        repositories: ["api", "api-client"],
        workspaceRoot: dir,
      }),
    );
    const code = await run([
      "path",
      "api",
      "--manifest",
      join(dir, "workspace.json"),
    ]);
    assertEquals(code, 1);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("wspace path --json returns all matches", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "repos", "api"), { recursive: true });
    await Deno.mkdir(join(dir, "repos", "api-client"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "workspace.json"),
      JSON.stringify({
        schemaVersion: 4,
        owner: "acme",
        repositories: ["api", "api-client"],
        workspaceRoot: dir,
      }),
    );
    const stdout = captureStdout();
    const code = await run([
      "path",
      "api",
      "--json",
      "--manifest",
      join(dir, "workspace.json"),
    ]);
    stdout.stop();
    assertEquals(code, 0);
    const results = JSON.parse(stdout.output());
    assertEquals(results.length, 2);
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

Deno.test("wspace i alias clones missing repositories", async () => {
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
    const code = await run(["i", "--manifest", manifestPath]);
    assertEquals(code, 0);
    assertEquals(
      await exists(join(dir, "repos", "a", ".git")),
      true,
      "repo a should be cloned via alias",
    );
    assertEquals(
      await exists(join(dir, "repos", "b", ".git")),
      true,
      "repo b should be cloned via alias",
    );
  } finally {
    await removeTempDir(dir);
  }
});

export type { GitRunner };
