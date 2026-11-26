import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { makeTempDir, readText } from "./helpers.ts";
import { pathExists } from "@/runtime.ts";
import { dirname, join } from "@std/path";
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
  await writeFile(join(seed, "a.txt"), "one\n");
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
  await writeFile(join(seed, "a.txt"), content);
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
  };
  return p;
}

/** Capture stdout output from console.log calls. */
function captureStdout() {
  let output = "";
  const original = console.log;
  console.log = (...args: unknown[]) => {
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

test("defaultBranch resolves from origin/HEAD", async () => {
  const dir = await makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    assert.deepEqual(await defaultBranch(g, work), "main");
  } finally {
    await removeTempDir(dir);
  }
});

test("branchAb reports ahead/behind after advance", async () => {
  const dir = await makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await seedCommitOnOrigin(dir, "a", "two\n");
    assert.deepEqual((await g.run(["fetch", "--prune"], work)).code, 0);
    assert.deepEqual(await branchAb(g, work, "origin/main"), {
      ahead: 0,
      behind: 1,
    });
  } finally {
    await removeTempDir(dir);
  }
});

test("update fast-forwards a clean default branch", async () => {
  const dir = await makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await seedCommitOnOrigin(dir, "a", "two\n");
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
    );
    assert.deepEqual(actions, [
      {
        kind: "FAST_FORWARD",
        name: "a",
        commits: 1,
      },
    ]);
    assert.deepEqual(await isDirty(g, work), false);
  } finally {
    await removeTempDir(dir);
  }
});

test("update skips dirty repositories", async () => {
  const dir = await makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await writeFile(join(work, "a.txt"), "local change\n");
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
    );
    assert.deepEqual(actions, [
      { kind: "SKIP_DIRTY", name: "a", detail: "uncommitted changes" },
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

test("update skips feature-branch checkouts", async () => {
  const dir = await makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await g.run(["checkout", "-b", "feature-x"], work);
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
    );
    assert.deepEqual(actions[0].kind, "SKIP_FEATURE");
  } finally {
    await removeTempDir(dir);
  }
});

test("update reports CURRENT when already in sync", async () => {
  const dir = await makeTempDir();
  try {
    await makeRepoWithMain(dir, "a");
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
    );
    assert.deepEqual(actions, [
      {
        kind: "CURRENT",
        name: "a",
        detail: "origin/main",
      },
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

test("update fast-forwards a clean workspace root", async () => {
  const dir = await makeTempDir();
  try {
    await makeRepoWithMain(dir, "root");
    await seedCommitOnOrigin(dir, "root", "two\n");
    const actions = await runUpdate(
      g,
      { repositories: [] },
      {
        root: join(dir, "root"),
        repositoriesDirectory: join(dir, "repos"),
      },
    );
    assert.deepEqual(actions, [
      { kind: "FAST_FORWARD", name: "(workspace root)", commits: 1 },
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

test("update skips a dirty workspace root", async () => {
  const dir = await makeTempDir();
  try {
    const rootDir = join(dir, "root");
    await makeRepoWithMain(dir, "root");
    // A tracked modification is user work; the root must be skipped.
    await writeFile(join(rootDir, "a.txt"), "local change\n");
    const actions = await runUpdate(
      g,
      { repositories: [] },
      {
        root: rootDir,
        repositoriesDirectory: join(dir, "repos"),
      },
    );
    assert.deepEqual(actions, [
      {
        kind: "SKIP_DIRTY",
        name: "(workspace root)",
        detail: "uncommitted changes",
      },
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

test("update skips a feature-branch workspace root", async () => {
  const dir = await makeTempDir();
  try {
    const rootDir = join(dir, "root");
    await makeRepoWithMain(dir, "root");
    await g.run(["checkout", "-b", "feature-x"], rootDir);
    const actions = await runUpdate(
      g,
      { repositories: [] },
      {
        root: rootDir,
        repositoriesDirectory: join(dir, "repos"),
      },
    );
    assert.deepEqual(actions[0].kind, "SKIP_FEATURE");
    assert.deepEqual(actions[0].name, "(workspace root)");
  } finally {
    await removeTempDir(dir);
  }
});

test("update reports CURRENT for an in-sync workspace root", async () => {
  const dir = await makeTempDir();
  try {
    await makeRepoWithMain(dir, "root");
    const actions = await runUpdate(
      g,
      { repositories: [] },
      {
        root: join(dir, "root"),
        repositoriesDirectory: join(dir, "repos"),
      },
    );
    assert.deepEqual(actions, [
      {
        kind: "CURRENT",
        name: "(workspace root)",
        detail: "origin/main",
      },
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

test("update omits the workspace root when it is not a git repo", async () => {
  const dir = await makeTempDir();
  try {
    await makeRepoWithMain(dir, "a");
    await seedCommitOnOrigin(dir, "a", "two\n");
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      pathsFor(dir),
    );
    assert(
      !actions.some((a) => a.name === "(workspace root)"),
      "plain-directory root should not produce an update action",
    );
    assert.deepEqual(actions, [
      {
        kind: "FAST_FORWARD",
        name: "a",
        commits: 1,
      },
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

test("collectStatus reports the workspace root when it is a git repo", async () => {
  const dir = await makeTempDir();
  try {
    await makeRepoWithMain(dir, "root");
    const rows = await collectStatus(
      g,
      { repositories: [] },
      {
        root: join(dir, "root"),
        repositoriesDirectory: join(dir, "repos"),
      },
    );
    assert.deepEqual(rows[0].name, "(workspace root)");
    assert.deepEqual(rows[0].state, "CLEAN");
  } finally {
    await removeTempDir(dir);
  }
});

test("check exits 1 when the workspace root is dirty", async () => {
  const dir = await makeTempDir();
  try {
    const rootDir = join(dir, "root");
    await makeRepoWithMain(dir, "root");
    await mkdir(join(rootDir, "repos"), { recursive: true });
    const manifestPath = join(rootDir, "workspace.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: rootDir,
        repositories: [],
      }),
    );
    // The manifest belongs to the root checkout; commit it so the root is a
    // clean git repo (mirrors a committed workspace.json in a real workspace).
    await configure(rootDir);
    await g.run(["add", "."], rootDir);
    await g.run(["commit", "-m", "workspace manifest"], rootDir);
    await g.run(["push", "origin", "main"], rootDir);
    assert.deepEqual(
      await run(["check", "--manifest", manifestPath]),
      0,
      "clean root should pass check",
    );
    // A tracked modification is user work; the root must fail check.
    await writeFile(join(rootDir, "a.txt"), "oops\n");
    assert.deepEqual(
      await run(["check", "--manifest", manifestPath]),
      1,
      "dirty workspace root should fail check",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("update ignores untracked workspace content in the workspace root", async () => {
  const dir = await makeTempDir();
  try {
    const rootDir = join(dir, "root");
    await makeRepoWithMain(dir, "root");
    // Untracked repos/ is the expected workspace content of the root
    // checkout (install populates it on a fresh clone); it must not make
    // the root permanently DIRTY.
    await mkdir(join(rootDir, "repos", "a"), { recursive: true });
    await seedCommitOnOrigin(dir, "root", "two\n");
    const actions = await runUpdate(
      g,
      { repositories: [] },
      {
        root: rootDir,
        repositoriesDirectory: join(rootDir, "repos"),
      },
    );
    assert.deepEqual(actions, [
      { kind: "FAST_FORWARD", name: "(workspace root)", commits: 1 },
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

test("collectStatus ignores untracked workspace content in the root", async () => {
  const dir = await makeTempDir();
  try {
    const rootDir = join(dir, "root");
    await makeRepoWithMain(dir, "root");
    await mkdir(join(rootDir, "repos", "a"), { recursive: true });
    const rows = await collectStatus(
      g,
      { repositories: [] },
      {
        root: rootDir,
        repositoriesDirectory: join(rootDir, "repos"),
      },
    );
    assert.deepEqual(rows[0].name, "(workspace root)");
    assert.deepEqual(rows[0].state, "CLEAN");
  } finally {
    await removeTempDir(dir);
  }
});

test("update omits the workspace root when scoped to a sub-workspace", async () => {
  const dir = await makeTempDir();
  try {
    const rootDir = join(dir, "root");
    await makeRepoWithMain(dir, "root");
    await seedCommitOnOrigin(dir, "root", "two\n");
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "a", url: "u" }] },
      {
        root: rootDir,
        repositoriesDirectory: join(dir, "repos"),
      },
      { includeRoot: false },
    );
    assert(
      !actions.some((a) => a.name === "(workspace root)"),
      "scoped update should omit the workspace root",
    );
    assert.deepEqual(actions, [{ kind: "MISSING", name: "a" }]);
  } finally {
    await removeTempDir(dir);
  }
});

test("collectStatus omits the workspace root when scoped", async () => {
  const dir = await makeTempDir();
  try {
    const rootDir = join(dir, "root");
    await makeRepoWithMain(dir, "root");
    await writeFile(join(rootDir, "a.txt"), "local change\n");
    const rows = await collectStatus(
      g,
      { repositories: [] },
      {
        root: rootDir,
        repositoriesDirectory: join(dir, "repos"),
      },
      { includeRoot: false },
    );
    assert(
      !rows.some((r) => r.name === "(workspace root)"),
      "scoped check should omit the workspace root",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("check --workspace ignores a dirty workspace root", async () => {
  const dir = await makeTempDir();
  try {
    const rootDir = join(dir, "root");
    await makeRepoWithMain(dir, "root");
    // Clone the repo attributed to sub-workspace "sub" into repos/a.
    await makeRepoWithMain(dir, "a");
    const reposA = join(rootDir, "repos", "a");
    await mkdir(dirname(reposA), { recursive: true });
    assert(
      (await g.run(["clone", join(dir, "a.git"), reposA])).code === 0,
      "clone a into repos",
    );
    await configure(reposA);

    const manifestPath = join(rootDir, "workspace.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: rootDir,
        repositories: [
          { name: "a", url: join(dir, "a.git"), workspace: "sub" },
        ],
      }),
    );
    await configure(rootDir);
    await g.run(["add", "."], rootDir);
    await g.run(["commit", "-m", "workspace manifest"], rootDir);
    await g.run(["push", "origin", "main"], rootDir);

    // A dirty root is user work and fails an unscoped check...
    await writeFile(join(rootDir, "a.txt"), "oops\n");
    assert.deepEqual(
      await run(["check", "--manifest", manifestPath]),
      1,
      "dirty root should fail an unscoped check",
    );
    // ...but a scoped check evaluates only the requested sub-workspace.
    assert.deepEqual(
      await run(["check", "--manifest", manifestPath, "--workspace", "sub"]),
      0,
      "scoped check should ignore the workspace root",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace install clones missing repositories", async () => {
  const dir = await makeTempDir();
  try {
    await makeRepoWithMain(dir, "a");
    await makeRepoWithMain(dir, "b");
    const manifestPath = join(dir, "workspace.json");
    await writeFile(
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
    assert.deepEqual(code, 0);
    assert.deepEqual(
      await pathExists(join(dir, "repos", "b", ".git")),
      true,
      "missing repo should be cloned",
    );
    assert.deepEqual(
      await pathExists(join(dir, "repos", "b", "a.txt")),
      true,
      "cloned repo should contain seeded file",
    );
    assert.deepEqual(
      await pathExists(join(dir, "repos", "a", ".git")),
      true,
      "existing-origin repo a should also be cloned",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace install clones only specified subset of repositories", async () => {
  const dir = await makeTempDir();
  try {
    await makeRepoWithMain(dir, "a");
    await makeRepoWithMain(dir, "b");
    await makeRepoWithMain(dir, "c");
    const manifestPath = join(dir, "workspace.json");
    await writeFile(
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
    assert.deepEqual(code, 0);
    assert.deepEqual(
      await pathExists(join(dir, "repos", "b", ".git")),
      true,
      "specified repo b should be cloned",
    );
    assert.deepEqual(
      await pathExists(join(dir, "repos", "a", ".git")),
      false,
      "unspecified repo a should not be cloned",
    );
    assert.deepEqual(
      await pathExists(join(dir, "repos", "c", ".git")),
      false,
      "unspecified repo c should not be cloned",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace check reports CLEAN via CLI", async () => {
  const dir = await makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    const manifestPath = join(dir, "workspace.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        repositoriesDirectory: ".",
        repositories: [{ name: "a", url: "u" }],
      }),
    );
    const code = await run(["check", "--json", "--manifest", manifestPath]);
    assert.deepEqual(code, 0);
    assert(work, "sanity: checkout exists");
  } finally {
    await removeTempDir(dir);
  }
});

test("repoStatus reports MISSING when path does not exist", async () => {
  const dir = await makeTempDir();
  try {
    const rows = await collectStatus(
      g,
      { repositories: [{ name: "nope", url: "u" }] },
      pathsFor(dir),
    );
    assert.deepEqual(rows[0].state, "MISSING");
  } finally {
    await removeTempDir(dir);
  }
});

test("repoStatus reports INVALID when path has no .git", async () => {
  const dir = await makeTempDir();
  try {
    const empty = join(dir, "empty");
    await mkdir(empty, { recursive: true });
    const rows = await collectStatus(
      g,
      {
        repositories: [
          {
            name: "empty",
            url: "u",
            resolvedPath: empty,
          },
        ],
      },
      pathsFor(dir),
    );
    assert.deepEqual(rows[0].state, "INVALID");
    assert.deepEqual(rows[0].detail, "Path exists but is not a Git repository");
  } finally {
    await removeTempDir(dir);
  }
});

test("update reports INVALID with a clear detail when a repo path is not a git repo", async () => {
  const dir = await makeTempDir();
  try {
    const empty = join(dir, "empty");
    await mkdir(empty, { recursive: true });
    const actions = await runUpdate(
      g,
      {
        repositories: [
          {
            name: "empty",
            url: "u",
            resolvedPath: empty,
          },
        ],
      },
      pathsFor(dir),
    );
    assert.deepEqual(actions, [
      {
        kind: "INVALID",
        name: "empty",
        detail: "Path exists but is not a Git repository",
      },
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

test("collectStatus flags unmanaged checkouts under repos dir", async () => {
  const dir = await makeTempDir();
  try {
    const reposDir = join(dir, "repos");
    await mkdir(reposDir, { recursive: true });
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
    assert.deepEqual(unmanagedRow.state, "CLEAN");
  } finally {
    await removeTempDir(dir);
  }
});

test("defaultBranch falls back to main when origin/HEAD is missing", async () => {
  const dir = await makeTempDir();
  try {
    const work = await makeRepoWithMain(dir, "a");
    await g.run(["remote", "set-head", "origin", "--delete"], work);
    assert.deepEqual(await defaultBranch(g, work), "main");
  } finally {
    await removeTempDir(dir);
  }
});

test("collectStatus reports hasErrors for MISSING and INVALID", async () => {
  const dir = await makeTempDir();
  try {
    const empty = join(dir, "empty");
    await mkdir(empty, { recursive: true });
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
    assert.deepEqual(rows.map((r) => r.state).sort(), ["INVALID", "MISSING"]);
  } finally {
    await removeTempDir(dir);
  }
});

test("collectStatus does not double-list managed repositories under reposDir", async () => {
  const dir = await makeTempDir();
  try {
    const reposDir = join(dir, "repos");
    await mkdir(reposDir, { recursive: true });
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
    assert.deepEqual(
      names,
      ["a"],
      "Managed repository should be reported exactly once",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace install fails when destination exists but is not a Git repo", async () => {
  const dir = await makeTempDir();
  try {
    const nonGitPath = join(dir, "repos", "blocked");
    await mkdir(nonGitPath, { recursive: true });
    const manifestPath = join(dir, "workspace.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        repositories: [{ name: "blocked", url: "u" }],
      }),
    );
    const code = await run(["install", "--manifest", manifestPath]);
    assert.deepEqual(
      code,
      1,
      "wspace install should exit non-zero when path is blocked",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace init scaffolds a manifest and standard directories", async () => {
  const dir = await makeTempDir();
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
    assert.deepEqual(code, 0);
    const doc = JSON.parse(await readText(manifestPath)) as {
      schemaVersion: number;
      host?: string;
      owner?: string;
      repositories: string[];
    };
    assert.deepEqual(doc.schemaVersion, 4);
    assert.deepEqual(doc.host, "github.com");
    assert.deepEqual(doc.owner, "acme");
    assert.deepEqual(doc.repositories, ["api", "other/tool"]);
    assert(await pathExists(join(dir, "repos")), "repos/ should be created");
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace init refuses when a manifest already exists", async () => {
  const dir = await makeTempDir();
  try {
    const manifestPath = join(dir, "workspace.json");
    const original = JSON.stringify({
      repositories: [{ name: "a", url: "u" }],
    });
    await writeFile(manifestPath, original);
    const code = await run([
      "init",
      "--owner",
      "acme",
      "b",
      "--manifest",
      manifestPath,
    ]);
    assert.deepEqual(code, 2);
    assert.deepEqual(
      await readText(manifestPath),
      original,
      "existing manifest must remain untouched",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace init fails closed on invalid seeds without writing anything", async () => {
  const dir = await makeTempDir();
  try {
    const missingOwner = await run([
      "init",
      "--manifest",
      join(dir, "workspace.json"),
      "orphan",
    ]);
    assert.deepEqual(missingOwner, 2, "shorthand without owner must fail");
    assert.deepEqual(
      await pathExists(join(dir, "workspace.json")),
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
    assert.deepEqual(dup, 2, "duplicate seeded names must fail");
    assert.deepEqual(
      await pathExists(join(dir, "repos.json")),
      false,
      "failed scaffold must not write a manifest",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("init-scaffolded manifest feeds wspace install end-to-end", async () => {
  const dir = await makeTempDir();
  try {
    // Local bare origin standing in for github.com/acme/api.
    const origin = join(dir, "api.git");
    const seed = join(dir, "api-seed");
    assert((await g.run(["init", "--bare", origin])).code === 0);
    assert((await g.run(["init", seed])).code === 0);
    await configure(seed);
    assert((await g.run(["checkout", "-b", "main"], seed)).code === 0);
    await writeFile(join(seed, "a.txt"), "one\n");
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
        assert.deepEqual(
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
        assert.deepEqual(
          await run(["install", "--manifest", manifestPath]),
          0,
          "install should clone from the scaffolded shorthand entry",
        );
      },
    );
    assert(
      await pathExists(join(dir, "repos", "api", ".git")),
      "scaffolded shorthand should install from the rewritten remote",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace add appends shorthand entries without touching remotes", async () => {
  const dir = await makeTempDir();
  try {
    const manifestPath = join(dir, "workspace.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 4,
        host: "gitlab.com",
        owner: "acme",
        repositories: [{ name: "existing", url: "https://x/existing.git" }],
      }),
    );
    assert.deepEqual(
      await run(["add", "acme/api", "--manifest", manifestPath]),
      0,
      "shorthand with inline owner should skip remote checks",
    );
    assert.deepEqual(
      await run(["add", "tool", "--manifest", manifestPath]),
      0,
      "bare shorthand should expand against host without remote checks",
    );
    const { repositories } = await loadManifest(manifestPath);
    assert.deepEqual(
      repositories.map((r) => r.name),
      ["existing", "api", "tool"],
    );
    assert.deepEqual(repositories[2].url, "https://gitlab.com/acme/tool");
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace add --url derives the name from the URL basename", async () => {
  const dir = await makeTempDir();
  try {
    const manifestPath = join(dir, "workspace.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 4, repositories: [] }),
    );
    assert.deepEqual(
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
    assert.deepEqual(repositories[0].name, "memsdk");

    assert.deepEqual(
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
    assert.deepEqual(repositories[1].name, "aliased");
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace add rejects duplicates and missing manifests fail closed", async () => {
  const dir = await makeTempDir();
  try {
    const missing = join(dir, "workspace.json");
    assert.deepEqual(
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
    await writeFile(manifestPath, original);
    assert.deepEqual(
      await run(["add", "other/api", "--manifest", manifestPath]),
      2,
      "duplicate local name should exit 2",
    );
    assert.deepEqual(
      await readText(manifestPath),
      original,
      "failed add must not touch the manifest",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace remove deletes the entry but keeps the checkout on disk", async () => {
  const dir = await makeTempDir();
  try {
    await makeRepoWithMain(dir, "a");
    const manifestPath = join(dir, "workspace.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        repositoriesDirectory: ".",
        repositories: [{ name: "a", url: join(dir, "a.git") }],
      }),
    );
    assert.deepEqual(await run(["remove", "a", "--manifest", manifestPath]), 0);
    const { repositories } = await loadManifest(manifestPath);
    assert.deepEqual(repositories.length, 0);
    assert.deepEqual(
      await pathExists(join(dir, "a")),
      true,
      "local checkout must remain on disk after remove",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace remove fails on unknown names and dry-run writes nothing", async () => {
  const dir = await makeTempDir();
  try {
    const manifestPath = join(dir, "workspace.json");
    const original = JSON.stringify({
      schemaVersion: 4,
      host: "gitlab.com",
      owner: "acme",
      repositories: ["api"],
    });
    await writeFile(manifestPath, original);

    assert.deepEqual(
      await run(["remove", "nope", "--manifest", manifestPath]),
      2,
      "unknown repository should exit 2",
    );
    assert.deepEqual(await readText(manifestPath), original);

    assert.deepEqual(
      await run(["remove", "api", "--dry-run", "--manifest", manifestPath]),
      0,
      "dry-run should succeed",
    );
    assert.deepEqual(
      await readText(manifestPath),
      original,
      "dry-run must not write the manifest",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace path finds repo in repos/", async () => {
  const dir = await makeTempDir();
  try {
    const reposDir = join(dir, "repos");
    await mkdir(join(reposDir, "my-api"), { recursive: true });
    await writeFile(
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
    assert.deepEqual(code, 0);
    assert.deepEqual(stdout.output().trim(), join(reposDir, "my-api"));
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace path returns exit 1 for no match", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, "repos", "a"), { recursive: true });
    await writeFile(
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
    assert.deepEqual(code, 1);
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace path returns exit 1 for ambiguous query", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, "repos", "api"), { recursive: true });
    await mkdir(join(dir, "repos", "api-client"), { recursive: true });
    await writeFile(
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
    assert.deepEqual(code, 1);
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace path --json returns all matches", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, "repos", "api"), { recursive: true });
    await mkdir(join(dir, "repos", "api-client"), { recursive: true });
    await writeFile(
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
    assert.deepEqual(code, 0);
    const results = JSON.parse(stdout.output());
    assert.deepEqual(results.length, 2);
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
      await rm(dir, { recursive: true });
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
  const sections = rules
    .map(
      (r) => `[url "${base}/"]\n\tinsteadOf = https://${r.host}/${r.owner}/\n`,
    )
    .join("");
  await writeFile(cfgPath, sections);
  const prior = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfgPath;
  try {
    await fn();
  } finally {
    if (prior === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = prior;
    }
  }
}

test("loadManifest rejects a legacy vaultDirectory through the CLI path", async () => {
  const dir = await makeTempDir();
  try {
    const manifestPath = join(dir, "repos.json");
    await writeFile(
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
      threw.includes('vaultDirectory" was removed'),
      `expected rename migration error, got: ${threw}`,
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("wspace i alias clones missing repositories", async () => {
  const dir = await makeTempDir();
  try {
    await makeRepoWithMain(dir, "a");
    await makeRepoWithMain(dir, "b");
    const manifestPath = join(dir, "workspace.json");
    await writeFile(
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
    assert.deepEqual(code, 0);
    assert.deepEqual(
      await pathExists(join(dir, "repos", "a", ".git")),
      true,
      "repo a should be cloned via alias",
    );
    assert.deepEqual(
      await pathExists(join(dir, "repos", "b", ".git")),
      true,
      "repo b should be cloned via alias",
    );
  } finally {
    await removeTempDir(dir);
  }
});

export type { GitRunner };
