import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";
import { run } from "@/cli.ts";
import { clearBlockingPath } from "@/commands/install-force.ts";
import { isWindows } from "@/runtime.ts";
import { g, makeRepoWithMain, removeTempDir } from "./sweep_helpers.ts";

async function tempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "wspace-force-" });
}

Deno.test("clearBlockingPath clears an empty directory", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "repo");
    await Deno.mkdir(target);
    assertEquals(await clearBlockingPath("repo", target, false), {
      kind: "cleared",
    });
    assertEquals(await exists(target), false);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("clearBlockingPath clears a tree of only empty directories", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "repo");
    await Deno.mkdir(join(target, "a", "b"), { recursive: true });
    await Deno.mkdir(join(target, "c"), { recursive: true });
    assertEquals(
      (await clearBlockingPath("repo", target, false)).kind,
      "cleared",
    );
    assertEquals(await exists(target), false);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("clearBlockingPath refuses a directory holding a file", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "repo");
    await Deno.mkdir(target);
    await Deno.writeTextFile(join(target, "notes.txt"), "keep me");
    const result = await clearBlockingPath("repo", target, false);
    assert(result.kind === "row");
    assertEquals(result.row.state, "PATH_BLOCKED");
    assertStringIncludes(result.row.detail ?? "", "notes.txt");
    assertEquals(await Deno.readTextFile(join(target, "notes.txt")), "keep me");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("clearBlockingPath refuses a file nested in subdirectories and removes nothing", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "repo");
    await Deno.mkdir(join(target, "a", "b"), { recursive: true });
    await Deno.mkdir(join(target, "empty"));
    await Deno.writeTextFile(join(target, "a", "b", "deep.txt"), "x");
    const result = await clearBlockingPath("repo", target, false);
    assert(result.kind === "row" && result.row.state === "PATH_BLOCKED");
    assert(await exists(join(target, "a", "b", "deep.txt")));
    assert(await exists(join(target, "empty")), "no partial deletion");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("clearBlockingPath refuses a plain file at the path", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "repo");
    await Deno.writeTextFile(target, "x");
    const result = await clearBlockingPath("repo", target, false);
    assert(result.kind === "row" && result.row.state === "PATH_BLOCKED");
    assert(await exists(target));
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test({
  name: "clearBlockingPath never removes a symlink, even to an empty directory",
  // Creating symlinks on Windows needs Developer Mode or elevation.
  ignore: isWindows(),
  fn: async () => {
    const dir = await tempDir();
    try {
      const real = join(dir, "real");
      const link = join(dir, "link");
      await Deno.mkdir(real);
      await Deno.symlink(real, link);
      const result = await clearBlockingPath("repo", link, false);
      assert(result.kind === "row" && result.row.state === "PATH_BLOCKED");
      assert((await Deno.lstat(link)).isSymlink, "link survives");
      assert(await exists(real), "target survives");
    } finally {
      await removeTempDir(dir);
    }
  },
});

Deno.test("clearBlockingPath leaves a valid checkout and a missing path alone", async () => {
  const dir = await tempDir();
  try {
    const work = await makeRepoWithMain(dir, "real");
    assertEquals((await clearBlockingPath("real", work, false)).kind, "none");
    assert(await exists(join(work, ".git")));
    assertEquals(
      (await clearBlockingPath("gone", join(dir, "gone"), false)).kind,
      "none",
    );
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("clearBlockingPath --dry-run reports WOULD_CLEAR and removes nothing", async () => {
  const dir = await tempDir();
  try {
    const target = join(dir, "repo");
    await Deno.mkdir(join(target, "sub"), { recursive: true });
    const result = await clearBlockingPath("repo", target, true);
    assert(result.kind === "row");
    assertEquals(result.row.state, "WOULD_CLEAR");
    assert(await exists(join(target, "sub")));
  } finally {
    await removeTempDir(dir);
  }
});

async function installFixture(dir: string): Promise<string> {
  await makeRepoWithMain(dir, "blocked");
  const manifestPath = join(dir, "workspace.json");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      workspaceRoot: dir,
      repositories: [{ name: "blocked", url: join(dir, "blocked.git") }],
    }),
  );
  await Deno.mkdir(join(dir, "repos", "blocked"), { recursive: true });
  return manifestPath;
}

Deno.test("install --force clears an empty placeholder, then clones", async () => {
  const dir = await tempDir();
  try {
    const manifestPath = await installFixture(dir);
    const code = await run(["install", "--manifest", manifestPath, "--force"]);
    assertEquals(code, 0);
    assert(await exists(join(dir, "repos", "blocked", ".git")), "cloned");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("install without --force still fails closed on a placeholder", async () => {
  const dir = await tempDir();
  try {
    const manifestPath = await installFixture(dir);
    assertEquals(await run(["install", "--manifest", manifestPath]), 1);
    assert(await exists(join(dir, "repos", "blocked")), "path untouched");
    assertEquals(await exists(join(dir, "repos", "blocked", ".git")), false);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("install --force keeps a directory holding a file blocked", async () => {
  const dir = await tempDir();
  try {
    const manifestPath = await installFixture(dir);
    const keep = join(dir, "repos", "blocked", "work.txt");
    await Deno.writeTextFile(keep, "unsaved");
    assertEquals(
      await run(["install", "--manifest", manifestPath, "--force"]),
      1,
    );
    assertEquals(await Deno.readTextFile(keep), "unsaved");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("install --force --dry-run previews and changes nothing", async () => {
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
    assertEquals(code, 0);
    assert(await exists(join(dir, "repos", "blocked")), "placeholder kept");
    assertEquals(await exists(join(dir, "repos", "blocked", ".git")), false);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("install --force leaves an existing checkout untouched", async () => {
  const dir = await tempDir();
  try {
    const manifestPath = await installFixture(dir);
    await Deno.remove(join(dir, "repos", "blocked"));
    const clone = await g.run([
      "clone",
      join(dir, "blocked.git"),
      join(dir, "repos", "blocked"),
    ]);
    assertEquals(clone.code, 0);
    await Deno.writeTextFile(join(dir, "repos", "blocked", "wip.txt"), "wip");
    assertEquals(
      await run(["install", "--manifest", manifestPath, "--force"]),
      0,
    );
    assertEquals(
      await Deno.readTextFile(join(dir, "repos", "blocked", "wip.txt")),
      "wip",
    );
  } finally {
    await removeTempDir(dir);
  }
});
