import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { makeTempDir, runCli } from "./helpers.ts";
import { pathExists } from "@/runtime.ts";
import { join } from "@std/path";
import { run } from "@/cli.ts";
import { runUpdate } from "@/update.ts";
import { SystemGit } from "@/git.ts";

const g = new SystemGit();

async function configure(dir: string): Promise<void> {
  await g.run(["config", "user.email", "works-test@example.com"], dir);
  await g.run(["config", "user.name", "WSC Test"], dir);
  await g.run(["config", "commit.gpgsign", "false"], dir);
}

async function makeRepoWithMain(dir: string, name: string): Promise<string> {
  const origin = join(dir, `${name}.git`);
  const seed = join(dir, `${name}-seed`);
  const r1 = await g.run(["init", "--bare", origin]);
  assert(r1.code === 0, "init bare");
  const r2 = await g.run(["init", seed]);
  assert(r2.code === 0, "init seed");
  await configure(seed);
  const r3 = await g.run(["checkout", "-b", "main"], seed);
  assert(r3.code === 0, "checkout main");
  await writeFile(join(seed, "a.txt"), "one\n");
  await g.run(["add", "."], seed);
  const r4 = await g.run(["commit", "-m", "seed"], seed);
  assert(r4.code === 0, "seed commit");
  const r5 = await g.run(["push", origin, "main"], seed);
  assert(r5.code === 0, "push main");
  await g.run(["symbolic-ref", "HEAD", "refs/heads/main"], origin);
  await rm(seed, { recursive: true });
  return origin;
}

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true }).catch(() => {});
}

test("install --dry-run reports WOULD_CLONE without creating dirs", async () => {
  const dir = await makeTempDir();
  try {
    await makeRepoWithMain(dir, "dry-repo");
    const manifestPath = join(dir, "workspace.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        repositories: [{ name: "dry-repo", url: join(dir, "dry-repo.git") }],
      }),
    );

    const code = await run([
      "install",
      "--manifest",
      manifestPath,
      "--dry-run",
    ]);
    assert.deepEqual(code, 0);
    assert.deepEqual(
      await pathExists(join(dir, "repos", "dry-repo")),
      false,
      "repo should NOT be cloned during dry-run",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("install --dry-run --json outputs WOULD_CLONE", async () => {
  const dir = await makeTempDir();
  try {
    await makeRepoWithMain(dir, "dry-json");
    const manifestPath = join(dir, "workspace.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        repositories: [{ name: "dry-json", url: join(dir, "dry-json.git") }],
      }),
    );

    const output = await runCli([
      "install",
      "--manifest",
      manifestPath,
      "--dry-run",
      "--json",
    ]);
    const stdout = output.stdout;
    assert(
      stdout.includes("WOULD_CLONE"),
      `expected WOULD_CLONE in output, got: ${stdout}`,
    );
    assert.deepEqual(
      await pathExists(join(dir, "repos", "dry-json")),
      false,
      "repo should NOT be cloned during dry-run",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("update --dry-run reports WOULD_FAST_FORWARD without fetching", async () => {
  const dir = await makeTempDir();
  try {
    const origin = await makeRepoWithMain(dir, "upd");
    const cloneDir = join(dir, "repos", "upd");
    await g.run(["clone", origin, cloneDir]);

    // Create a new commit on origin so the clone is behind
    const seed = join(dir, "upd-seed");
    await g.run(["clone", origin, seed]);
    await configure(seed);
    await writeFile(join(seed, "b.txt"), "two\n");
    await g.run(["add", "."], seed);
    await g.run(["commit", "-m", "second"], seed);
    await g.run(["push", "origin", "main"], seed);
    await rm(seed, { recursive: true });

    const paths = {
      root: dir,
      repositoriesDirectory: join(dir, "repos"),
    };
    const actions = await runUpdate(
      g,
      { repositories: [{ name: "upd", url: origin, resolvedPath: cloneDir }] },
      paths,
      { dryRun: true },
    );
    const wouldFf = actions.find((a) => a.kind === "WOULD_FAST_FORWARD");
    assert(
      wouldFf,
      `expected WOULD_FAST_FORWARD action, got: ${JSON.stringify(actions)}`,
    );
    assert.deepEqual(wouldFf.name, "upd");
  } finally {
    await removeTempDir(dir);
  }
});

test("--dry-run appears in global help text", async () => {
  const output = await runCli(["--help"]);
  const stdout = output.stdout;
  assert(stdout.includes("--dry-run"), "expected --dry-run in help text");
  assert(
    stdout.includes("Preview write operations"),
    "expected dry-run description in help text",
  );
});

test("install reports INVALID for an existing workspace checkout missing its manifest", async () => {
  const dir = await makeTempDir();
  try {
    const workspaceDir = join(dir, "repos", "platform");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(join(workspaceDir, ".git"));
    const manifestPath = join(dir, "workspace.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        workspaceRoot: dir,
        repositories: [],
        workspaces: [{ name: "platform", url: join(dir, "platform.git") }],
      }),
    );

    const output = await runCli([
      "install",
      "--manifest",
      manifestPath,
      "--json",
    ]);
    const stdout = output.stdout;
    const stderr = output.stderr;
    assert(
      stdout.includes('"state": "INVALID"'),
      `expected INVALID row in stdout, got: ${stdout}\nstderr: ${stderr}`,
    );
    assert(
      stdout.includes("does not contain a workspace.json manifest"),
      `expected manifest-missing detail, got: ${stdout}`,
    );
    assert.deepEqual(output.code, 1);
  } finally {
    await removeTempDir(dir);
  }
});
