import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, rmdir, symlink, writeFile } from "node:fs/promises";
import { makeTempDir, readText } from "./helpers.ts";
import { join } from "@std/path";
import { run } from "@/cli.ts";
import { clearBlockingPath } from "@/commands/install-force.ts";
import { isWindows, pathExists } from "@/runtime.ts";
import { g, makeRepoWithMain, removeTempDir } from "./sweep_helpers.ts";

async function tempDir(): Promise<string> {
  return await makeTempDir("wspace-force-");
}

test("clearBlockingPath clears an empty directory", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "repo");
    await mkdir(target);
    assert.deepEqual(await clearBlockingPath("repo", target, false), {
      kind: "cleared",
    });
    assert.deepEqual(await pathExists(target), false);
  } finally {
    await removeTempDir(dir);
  }
});

test("clearBlockingPath clears a tree of only empty directories", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "repo");
    await mkdir(join(target, "a", "b"), { recursive: true });
    await mkdir(join(target, "c"), { recursive: true });
    assert.deepEqual(
      (await clearBlockingPath("repo", target, false)).kind,
      "cleared",
    );
    assert.deepEqual(await pathExists(target), false);
  } finally {
    await removeTempDir(dir);
  }
});

test("clearBlockingPath refuses a directory holding a file", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "repo");
    await mkdir(target);
    await writeFile(join(target, "notes.txt"), "keep me");
    const result = await clearBlockingPath("repo", target, false);
    assert(result.kind === "row");
    assert.deepEqual(result.row.state, "PATH_BLOCKED");
    assert(result.row.detail?.includes("notes.txt"), "detail names notes.txt");
    assert.deepEqual(await readText(join(target, "notes.txt")), "keep me");
  } finally {
    await removeTempDir(dir);
  }
});

test("clearBlockingPath refuses a file nested in subdirectories and removes nothing", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "repo");
    await mkdir(join(target, "a", "b"), { recursive: true });
    await mkdir(join(target, "empty"));
    await writeFile(join(target, "a", "b", "deep.txt"), "x");
    const result = await clearBlockingPath("repo", target, false);
    assert(result.kind === "row" && result.row.state === "PATH_BLOCKED");
    assert(await pathExists(join(target, "a", "b", "deep.txt")));
    assert(await pathExists(join(target, "empty")), "no partial deletion");
  } finally {
    await removeTempDir(dir);
  }
});

test("clearBlockingPath refuses a plain file at the path", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "repo");
    await writeFile(target, "x");
    const result = await clearBlockingPath("repo", target, false);
    assert(result.kind === "row" && result.row.state === "PATH_BLOCKED");
    assert(await pathExists(target));
  } finally {
    await removeTempDir(dir);
  }
});

// Creating symlinks on Windows needs Developer Mode or elevation.
test(
  "clearBlockingPath never removes a symlink, even to an empty directory",
  { skip: isWindows() },
  async () => {
    const dir = await tempDir();
    try {
      const real = join(dir, "real");
      const link = join(dir, "link");
      await mkdir(real);
      await symlink(real, link);
      const result = await clearBlockingPath("repo", link, false);
      assert(result.kind === "row" && result.row.state === "PATH_BLOCKED");
      assert((await lstat(link)).isSymbolicLink(), "link survives");
      assert(await pathExists(real), "target survives");
    } finally {
      await removeTempDir(dir);
    }
  },
);

test("clearBlockingPath leaves a valid checkout and a missing path alone", async () => {
  const dir = await tempDir();
  try {
    const work = await makeRepoWithMain(dir, "real");
    assert.deepEqual(
      (await clearBlockingPath("real", work, false)).kind,
      "none",
    );
    assert(await pathExists(join(work, ".git")));
    assert.deepEqual(
      (await clearBlockingPath("gone", join(dir, "gone"), false)).kind,
      "none",
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("clearBlockingPath --dry-run reports WOULD_CLEAR and removes nothing", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "repo");
    await mkdir(join(target, "sub"), { recursive: true });
    const result = await clearBlockingPath("repo", target, true);
    assert(result.kind === "row");
    assert.deepEqual(result.row.state, "WOULD_CLEAR");
    assert(await pathExists(join(target, "sub")));
  } finally {
    await removeTempDir(dir);
  }
});

async function installFixture(dir: string): Promise<string> {
  await makeRepoWithMain(dir, "blocked");
  const manifestPath = join(dir, "workspace.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      workspaceRoot: dir,
      repositories: [{ name: "blocked", url: join(dir, "blocked.git") }],
    }),
  );
  await mkdir(join(dir, "repos", "blocked"), { recursive: true });
  return manifestPath;
}

test("install --force clears an empty placeholder, then clones", async () => {
  const dir = await tempDir();
  try {
    const manifestPath = await installFixture(dir);
    const code = await run(["install", "--manifest", manifestPath, "--force"]);
    assert.deepEqual(code, 0);
    assert(await pathExists(join(dir, "repos", "blocked", ".git")), "cloned");
  } finally {
    await removeTempDir(dir);
  }
});

test("install without --force still fails closed on a placeholder", async () => {
  const dir = await tempDir();
  try {
    const manifestPath = await installFixture(dir);
    assert.deepEqual(await run(["install", "--manifest", manifestPath]), 1);
    assert(await pathExists(join(dir, "repos", "blocked")), "path untouched");
    assert.deepEqual(
      await pathExists(join(dir, "repos", "blocked", ".git")),
      false,
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("install --force keeps a directory holding a file blocked", async () => {
  const dir = await tempDir();
  try {
    const manifestPath = await installFixture(dir);
    const keep = join(dir, "repos", "blocked", "work.txt");
    await writeFile(keep, "unsaved");
    assert.deepEqual(
      await run(["install", "--manifest", manifestPath, "--force"]),
      1,
    );
    assert.deepEqual(await readText(keep), "unsaved");
  } finally {
    await removeTempDir(dir);
  }
});

test("install --force --dry-run previews and changes nothing", async () => {
  const dir = await tempDir();
  try {
    const manifestPath = await installFixture(dir);
    const code = await run([
      "install",
      "--manifest",
      manifestPath,
      "--force",
      "--dry-run",
    ]);
    assert.deepEqual(code, 0);
    assert(await pathExists(join(dir, "repos", "blocked")), "placeholder kept");
    assert.deepEqual(
      await pathExists(join(dir, "repos", "blocked", ".git")),
      false,
    );
  } finally {
    await removeTempDir(dir);
  }
});

test("install --force leaves an existing checkout untouched", async () => {
  const dir = await tempDir();
  try {
    const manifestPath = await installFixture(dir);
    await rmdir(join(dir, "repos", "blocked"));
    const clone = await g.run([
      "clone",
      join(dir, "blocked.git"),
      join(dir, "repos", "blocked"),
    ]);
    assert.deepEqual(clone.code, 0);
    await writeFile(join(dir, "repos", "blocked", "wip.txt"), "wip");
    assert.deepEqual(
      await run(["install", "--manifest", manifestPath, "--force"]),
      0,
    );
    assert.deepEqual(
      await readText(join(dir, "repos", "blocked", "wip.txt")),
      "wip",
    );
  } finally {
    await removeTempDir(dir);
  }
});
