import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { makeTempDir } from "./helpers.ts";
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
  await mkdir(join(childDir, ".git"), { recursive: true });
  await writeFile(
    join(childDir, "workspace.json"),
    JSON.stringify({
      repositories: [{ name: "shared", url: "https://example.com/shared.git" }],
      repositoriesDirectory: childRepositoriesDirectory,
    }),
  );
  const manifestPath = join(dir, "workspace.json");
  await writeFile(
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

test("validate rejects a cross-manifest checkout collision like check does", async () => {
  const dir = await makeTempDir();
  try {
    // Child repos resolve to <dir>/repos/shared, the root repo's checkout.
    const manifestPath = await makeTree(dir, "..");
    assert.deepEqual(await validate(manifestPath), 2);
    const check = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await run(["check", "--manifest", manifestPath]), 2);
    } finally {
      console.error = check;
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("validate accepts same-named repos at distinct checkout paths", async () => {
  const dir = await makeTempDir();
  try {
    const manifestPath = await makeTree(dir, "repos");
    assert.deepEqual(await validate(manifestPath), 0);
  } finally {
    await rm(dir, { recursive: true });
  }
});
