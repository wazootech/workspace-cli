import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { run } from "@/cli.ts";

/**
 * #144: `validate` must agree with `check`/`install` about cross-manifest
 * collisions. A child workspace whose `repositoriesDirectory` points back at
 * the root's `repos/` makes its repo resolve to the same checkout path as a
 * root repo, which the conflict gate rejects with exit 2.
 */
async function makeTree(
  dir: string,
  childRepositoriesDirectory: string,
): Promise<string> {
  const childDir = join(dir, "repos", "platform");
  await Deno.mkdir(join(childDir, ".git"), { recursive: true });
  await Deno.writeTextFile(
    join(childDir, "workspace.json"),
    JSON.stringify({
      repositories: [{ name: "shared", url: "https://example.com/shared.git" }],
      repositoriesDirectory: childRepositoriesDirectory,
    }),
  );
  const manifestPath = join(dir, "workspace.json");
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify({
      repositories: [{ name: "shared", url: "https://example.com/shared.git" }],
      workspaces: [{
        name: "platform",
        url: "https://example.com/platform.git",
      }],
    }),
  );
  return manifestPath;
}

async function validate(manifestPath: string): Promise<number> {
  const error = console.error;
  const log = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    return await run(["validate", "--manifest", manifestPath]);
  } finally {
    console.error = error;
    console.log = log;
  }
}

Deno.test("validate rejects a cross-manifest checkout collision like check does", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Child repos resolve to <dir>/repos/shared, the root repo's checkout.
    const manifestPath = await makeTree(dir, "..");
    assertEquals(await validate(manifestPath), 2);
    const check = console.error;
    console.error = () => {};
    try {
      assertEquals(await run(["check", "--manifest", manifestPath]), 2);
    } finally {
      console.error = check;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("validate accepts same-named repos at distinct checkout paths", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const manifestPath = await makeTree(dir, "repos");
    assertEquals(await validate(manifestPath), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
