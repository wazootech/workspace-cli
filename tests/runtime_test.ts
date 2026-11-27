import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { symlink } from "node:fs/promises";
import { assertRejects } from "./helpers.ts";
import { join, relative } from "@std/path";
import {
  currentDirectory,
  isWindows,
  makeDirectory,
  makeTempDirectory,
  pathExists,
  readDirectory,
  readTextFile,
  removePath,
  runProcess,
  walkDirectoryTree,
  writeTextFile,
} from "@/runtime.ts";

test("runProcess captures stdout and a zero exit code", async () => {
  const result = await runProcess("git", ["--version"]);
  assert.deepEqual(result.code, 0);
  assert(result.stdout.includes("git version"), result.stdout);
});

test("runProcess resolves rather than throwing on a non-zero exit", async () => {
  const result = await runProcess("git", [
    "rev-parse",
    "--verify",
    "definitely-not-a-ref-xyz",
  ]);
  assert(result.code !== 0, `expected a non-zero exit, got ${result.code}`);
});

test("runProcess rejects when the binary cannot be spawned", async () => {
  await assertRejects(() =>
    runProcess("wspace-definitely-not-a-real-binary-xyz", [])
  );
});

test("runProcess runs the subprocess in the requested directory", async () => {
  const dir = await makeTempDirectory("wspace-runtime-test-");
  try {
    assert.deepEqual((await runProcess("git", ["init"], { cwd: dir })).code, 0);
    const inside = await runProcess(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: dir },
    );
    assert.deepEqual(inside.stdout, "true");
  } finally {
    await removePath(dir);
  }
});

test("currentDirectory matches the runtime's own working directory", () => {
  assert.deepEqual(currentDirectory(), process.cwd());
});

test("isWindows agrees with process.platform", () => {
  assert.deepEqual(isWindows(), process.platform === "win32");
});

test("filesystem helpers round-trip", async () => {
  const dir = await makeTempDirectory("wspace-runtime-test-");
  try {
    const nested = join(dir, "a", "b");
    await makeDirectory(nested);
    assert.deepEqual(await pathExists(nested), true);

    const file = join(nested, "file.txt");
    assert.deepEqual(await pathExists(file), false);
    await writeTextFile(file, "hello");
    assert.deepEqual(await readTextFile(file), "hello");

    const entries = await readDirectory(nested);
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.isDirectory]),
      [["file.txt", false]],
    );

    await removePath(dir);
    assert.deepEqual(await pathExists(dir), false);
  } finally {
    if (await pathExists(dir)) await removePath(dir);
  }
});

test("makeTempDirectory creates a prefixed directory under the temp root", async () => {
  const dir = await makeTempDirectory("wspace-prefix-check-");
  try {
    assert(dir.includes("wspace-prefix-check-"));
    assert.deepEqual(await pathExists(dir), true);
  } finally {
    await removePath(dir);
  }
});

/**
 * A walk entry's label: its path relative to the walked root, with the root
 * itself spelled `"."`. Separators are normalised so expectations read the
 * same on Windows and Linux.
 */
function relativeLabel(root: string, path: string): string {
  if (path === root) return ".";
  return relative(root, path).replaceAll("\\", "/");
}

test("walkDirectoryTree returns the root, then its depth-first descendants", async () => {
  const dir = await makeTempDirectory("wspace-runtime-test-");
  try {
    await makeDirectory(join(dir, "a", "sub"));
    await makeDirectory(join(dir, "b"));
    await writeTextFile(join(dir, "top.txt"), "top");
    await writeTextFile(join(dir, "a", "file.txt"), "a");
    await writeTextFile(join(dir, "a", "sub", "deep.txt"), "deep");

    const entries = await walkDirectoryTree(dir, { maxDepth: 3 });
    const seen = entries
      .map((entry) =>
        `${relativeLabel(dir, entry.path)}${entry.isDirectory ? "/" : ""}`
      )
      .sort();
    assert.deepEqual(seen, [
      "./",
      "a/",
      "a/file.txt",
      "a/sub/",
      "a/sub/deep.txt",
      "b/",
      "top.txt",
    ]);
  } finally {
    await removePath(dir);
  }
});

test("walkDirectoryTree counts the root as depth 0 for maxDepth", async () => {
  const dir = await makeTempDirectory("wspace-runtime-test-");
  try {
    await makeDirectory(join(dir, "one", "two"));
    const depth1 = (await walkDirectoryTree(dir, {
      maxDepth: 1,
      includeFiles: false,
    })).map((entry) => relativeLabel(dir, entry.path)).sort();
    assert.deepEqual(depth1, [".", "one"]);
  } finally {
    await removePath(dir);
  }
});

test("walkDirectoryTree walks nothing for a negative maxDepth", async () => {
  const dir = await makeTempDirectory("wspace-runtime-test-");
  try {
    assert.deepEqual(await walkDirectoryTree(dir, { maxDepth: -1 }), []);
  } finally {
    await removePath(dir);
  }
});

test("walkDirectoryTree does not descend into skipped directories", async () => {
  const dir = await makeTempDirectory("wspace-runtime-test-");
  try {
    await makeDirectory(join(dir, "node_modules", "pkg"));
    await writeTextFile(join(dir, "node_modules", "pkg", "index.js"), "x");
    await makeDirectory(join(dir, "keep"));

    const entries = await walkDirectoryTree(dir, { skip: [/node_modules/] });
    assert.deepEqual(
      entries.map((entry) => relativeLabel(dir, entry.path)).sort(),
      [".", "keep"],
    );
  } finally {
    await removePath(dir);
  }
});

test("walkDirectoryTree matches skip against the whole path, not the basename", async () => {
  const dir = await makeTempDirectory("wspace-runtime-test-");
  try {
    await makeDirectory(join(dir, ".hidden", "inner"));

    // `@std/fs/walk` tested skip patterns against the full path, and so does
    // this. `/^\./` anchored to an absolute path therefore does not prune a
    // dot-directory under the root; `src/commands/path.ts` relies on its depth
    // rules for that. Pinning it here keeps a future "match the basename
    // instead" cleanup from silently changing `wspace path`.
    const entries = await walkDirectoryTree(dir, { skip: [/^\./] });
    assert(
      entries.some((entry) => entry.name === ".hidden"),
      "a dot-directory under the root is not skipped by /^\\./",
    );
  } finally {
    await removePath(dir);
  }
});

// Creating symlinks on Windows needs Developer Mode or elevation.
test(
  "walkDirectoryTree reports a symlinked directory as a non-directory and does not follow it",
  { skip: isWindows() },
  async () => {
    const dir = await makeTempDirectory("wspace-runtime-test-");
    try {
      await makeDirectory(join(dir, "real"));
      await writeTextFile(join(dir, "real", "inner.txt"), "x");
      await symlink(join(dir, "real"), join(dir, "link"));

      const entries = await walkDirectoryTree(dir);
      const link = entries.find((entry) => entry.name === "link");
      assert(link, "expected the symlink to be reported");
      assert.deepEqual(link.isDirectory, false);
      assert.deepEqual(
        entries.some((entry) => entry.path === join(dir, "link", "inner.txt")),
        false,
        "the symlink must not be followed",
      );
    } finally {
      await removePath(dir);
    }
  },
);

test("pathExists resolves false for a path that cannot be stat'd", async () => {
  const dir = await makeTempDirectory("wspace-runtime-test-");
  try {
    const file = join(dir, "file.txt");
    await writeTextFile(file, "x");
    // A child of a regular file fails with ENOTDIR rather than NotFound, and
    // `pathExists` still resolves rather than rejecting.
    assert.deepEqual(await pathExists(join(file, "child")), false);
  } finally {
    await removePath(dir);
  }
});
