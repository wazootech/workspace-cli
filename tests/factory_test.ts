import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  bootstrapFactory,
  smokeFactory,
  validateFactoryManifest,
} from "../src/factory.ts";
import { SystemGit } from "../src/git.ts";
import { run } from "../src/cli.ts";

const git = new SystemGit();

async function repo(): Promise<string> {
  const root = await Deno.makeTempDir();
  assertEquals((await git.run(["init", "-b", "main"], root)).code, 0);
  await git.run(["config", "user.email", "test@example.com"], root);
  await git.run(["config", "user.name", "Factory Test"], root);
  await Deno.writeTextFile(
    join(root, "package.json"),
    '{"scripts":{"format:check":"echo no","health:api":"echo no","smoke":"echo no"}}\n',
  );
  assertEquals((await git.run(["add", "package.json"], root)).code, 0);
  assertEquals((await git.run(["commit", "-m", "fixture"], root)).code, 0);
  return root;
}

Deno.test("factory manifest validation is separate and strict", () => {
  assertThrows(() => validateFactoryManifest({}), Error, "factoryVersion");
  assertThrows(
    () =>
      validateFactoryManifest({
        factoryVersion: "1.0.0",
        manifestVersion: 1,
        repository: { identity: "a", root: "x", defaultBranch: "main" },
        workflow: { mode: "light", smoke: "read-only" },
        commands: [],
        protectedPaths: [],
        definitionOfDone: [],
      }),
    Error,
    "checks",
  );
  assertThrows(
    () =>
      validateFactoryManifest({
        factoryVersion: "1.0.0",
        manifestVersion: 1,
        repository: { identity: "a", root: "x", defaultBranch: "main" },
        workflow: { mode: "light", smoke: "read-only" },
        commands: [],
        checks: { health: [], smoke: [] },
        protectedPaths: [],
      }),
    Error,
    "definitionOfDone",
  );
});

Deno.test("factory bootstrap is deterministic, idempotent, and handles Windows paths", async () => {
  const root = await repo();
  try {
    const first = await bootstrapFactory(git, root);
    assertEquals(first.actions.map((a) => a.action), ["create", "create"]);
    const content = await Deno.readTextFile(
      join(root, ".wazoo", "factory.json"),
    );
    const second = await bootstrapFactory(git, root.replaceAll("/", "\\"));
    assertEquals(second.actions.map((a) => a.action), [
      "unchanged",
      "unchanged",
    ]);
    assertEquals(
      await Deno.readTextFile(join(root, ".wazoo", "factory.json")),
      content,
    );
    assertEquals(second.manifest.commands, [
      "format:check",
      "health:api",
      "smoke",
    ]);
    assertEquals(second.manifest.checks, {
      health: ["health:api"],
      smoke: ["smoke"],
    });
    assertEquals(second.manifest.protectedPaths, [
      ".github/workflows",
      "migrations",
      "schema",
      "auth",
      "deploy",
      ".env",
      ".env.*",
      ".dev.vars",
      ".dev.vars.*",
    ]);
    assertEquals(second.manifest.repository.root, ".");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("factory dry-run has no side effects and conflicts require force", async () => {
  const root = await repo();
  try {
    const dry = await bootstrapFactory(git, root, { dryRun: true });
    assertEquals(dry.actions[0].action, "create");
    assertEquals(
      await Deno.stat(join(root, ".wazoo")).catch(() => undefined),
      undefined,
    );
    await bootstrapFactory(git, root);
    await Deno.writeTextFile(
      join(root, ".wazoo", "README.md"),
      "developer file\n",
    );
    const conflict = await bootstrapFactory(git, root, { dryRun: true });
    assertEquals(conflict.actions[1].action, "conflict");
    await bootstrapFactory(git, root, { force: true });
    assert(
      (await Deno.readTextFile(join(root, ".wazoo", "README.md"))).includes(
        "factory-managed",
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("factory smoke reports validity and dirty state without writing", async () => {
  const root = await repo();
  try {
    await bootstrapFactory(git, root);
    await Deno.writeTextFile(join(root, "local.txt"), "dirty\n");
    const result = await smokeFactory(git, root);
    assertEquals(result.valid, true);
    assertEquals(result.dirty, true);
    assertEquals(result.manifest?.workflow.smoke, "read-only");
    assertEquals(
      await Deno.stat(join(root, "local.txt")).then(() => true),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("factory refuses unrelated dirty changes but permits managed reruns", async () => {
  const root = await repo();
  try {
    await bootstrapFactory(git, root);
    await Deno.writeTextFile(join(root, "unrelated.txt"), "local\n");
    await assertRejects(
      () => bootstrapFactory(git, root, { force: true }),
      Error,
      "unrelated Git changes",
    );
    const dry = await bootstrapFactory(git, root, {
      dryRun: true,
      force: true,
    });
    assertEquals(dry.dryRun, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("factory rejects a rename from an unrelated path into .wazoo", async () => {
  const root = await repo();
  try {
    await bootstrapFactory(git, root);
    await Deno.writeTextFile(join(root, "unrelated.txt"), "local\n");
    assertEquals((await git.run(["add", "unrelated.txt"], root)).code, 0);
    assertEquals(
      (await git.run(["commit", "-m", "unrelated"], root)).code,
      0,
    );
    assertEquals(
      (await git.run(["mv", "unrelated.txt", ".wazoo/renamed.txt"], root))
        .code,
      0,
    );
    await assertRejects(
      () => bootstrapFactory(git, root, { force: true }),
      Error,
      "unrelated Git changes",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("factory smoke reports malformed package metadata", async () => {
  const root = await repo();
  try {
    await bootstrapFactory(git, root);
    await Deno.writeTextFile(join(root, "package.json"), "{\n");
    const result = await smokeFactory(git, root);
    assertEquals(result.valid, false);
    assert(result.error?.includes("Invalid package.json metadata"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("factory rejects symlinked managed files", async () => {
  const root = await repo();
  const outside = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, ".wazoo"));
    await Deno.writeTextFile(join(outside, "factory.json"), "outside\n");
    try {
      await Deno.symlink(
        join(outside, "factory.json"),
        join(root, ".wazoo", "factory.json"),
      );
    } catch (error) {
      if (String(error).includes("privilege")) return;
      throw error;
    }
    await assertRejects(
      () => bootstrapFactory(git, root),
      Error,
      "Refusing symlinked managed file",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("factory CLI rejects extra repository arguments", async () => {
  assertEquals(await run(["factory", "smoke", "one", "two"]), 2);
});

Deno.test("factory rejects an invalid path", async () => {
  const root = await Deno.makeTempDir();
  try {
    await assertRejects(
      () => bootstrapFactory(git, join(root, "missing")),
      Error,
      "Not a Git repository",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("factory smoke returns structured invalid reports without Git probing", async () => {
  const root = await Deno.makeTempDir();
  const missing = join(root, "missing");
  const file = join(root, "file.txt");
  await Deno.writeTextFile(file, "not a repository\n");
  try {
    for (const target of [missing, file, root]) {
      const result = await smokeFactory(git, target);
      assertEquals(result.valid, false);
      assertEquals(result.root, target);
      assertEquals(result.defaultBranch, "unknown");
      assertEquals(result.dirty, false);
      assertEquals(result.commands, []);
      assert(result.error?.includes("Not a Git repository"));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
