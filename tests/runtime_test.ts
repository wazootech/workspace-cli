import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
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
  writeTextFile,
} from "@/runtime.ts";

Deno.test("runProcess captures stdout and a zero exit code", async () => {
  const result = await runProcess("git", ["--version"]);
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, "git version");
});

Deno.test("runProcess resolves rather than throwing on a non-zero exit", async () => {
  const result = await runProcess("git", [
    "rev-parse",
    "--verify",
    "definitely-not-a-ref-xyz",
  ]);
  assert(result.code !== 0, `expected a non-zero exit, got ${result.code}`);
});

Deno.test("runProcess rejects when the binary cannot be spawned", async () => {
  await assertRejects(() =>
    runProcess("wspace-definitely-not-a-real-binary-xyz", [])
  );
});

Deno.test("runProcess runs the subprocess in the requested directory", async () => {
  const dir = await makeTempDirectory("wspace-runtime-test-");
  try {
    assertEquals((await runProcess("git", ["init"], { cwd: dir })).code, 0);
    const inside = await runProcess(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: dir },
    );
    assertEquals(inside.stdout, "true");
  } finally {
    await removePath(dir);
  }
});

Deno.test("currentDirectory matches the runtime's own working directory", () => {
  assertEquals(currentDirectory(), Deno.cwd());
});

Deno.test("isWindows agrees with Deno.build.os", () => {
  assertEquals(isWindows(), Deno.build.os === "windows");
});

Deno.test("filesystem helpers round-trip", async () => {
  const dir = await makeTempDirectory("wspace-runtime-test-");
  try {
    const nested = join(dir, "a", "b");
    await makeDirectory(nested);
    assertEquals(await pathExists(nested), true);

    const file = join(nested, "file.txt");
    assertEquals(await pathExists(file), false);
    await writeTextFile(file, "hello");
    assertEquals(await readTextFile(file), "hello");

    const entries = await readDirectory(nested);
    assertEquals(
      entries.map((entry) => [entry.name, entry.isDirectory]),
      [["file.txt", false]],
    );

    await removePath(dir);
    assertEquals(await pathExists(dir), false);
  } finally {
    if (await pathExists(dir)) await removePath(dir);
  }
});

Deno.test("makeTempDirectory creates a prefixed directory under the temp root", async () => {
  const dir = await makeTempDirectory("wspace-prefix-check-");
  try {
    assert(dir.includes("wspace-prefix-check-"));
    assertEquals(await pathExists(dir), true);
  } finally {
    await removePath(dir);
  }
});
