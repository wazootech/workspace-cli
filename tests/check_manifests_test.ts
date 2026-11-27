import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { join } from "@std/path";
import { makeTempDir } from "./helpers.ts";

const SCRIPT = fileURLToPath(
  new URL("../scripts/check-manifests.ts", import.meta.url),
);
const EXPORTS = { ".": "./src/mod.ts" };

async function run(
  imports: Record<string, string>,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string> = {},
) {
  const dir = await makeTempDir();
  await writeFile(
    join(dir, "jsr.json"),
    JSON.stringify({ exports: EXPORTS, imports }),
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ exports: EXPORTS, dependencies, devDependencies }),
  );
  return spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
}

const BASE = { "@worlds/sdk": "jsr:@worlds/sdk@^0.9.0" };
const BASE_DEP = { "@worlds/sdk": "npm:@jsr/worlds__sdk@^0.9.0" };

test("check-manifests: matching jsr and npm specs pass", async () => {
  const result = await run(
    { ...BASE, "@/": "./src/", zod: "npm:zod@^4.0.0" },
    { ...BASE_DEP, zod: "^4.0.0" },
    { oxlint: "1.0.0" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("check-manifests: a drifted range fails", async () => {
  const result = await run(BASE, {
    "@worlds/sdk": "npm:@jsr/worlds__sdk@^0.8.0",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@worlds\/sdk/);
});

test("check-manifests: an undeclared package.json dependency fails", async () => {
  const result = await run(BASE, { ...BASE_DEP, zod: "^4.0.0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not import it/);
});

test("check-manifests: a subpath import rides on its base import", async () => {
  const sub = {
    "@worlds/sdk/memory": "jsr:@worlds/sdk@^0.9.0/memory",
  };
  const withBase = await run({ ...BASE, ...sub }, BASE_DEP);
  assert.equal(withBase.status, 0, withBase.stderr);
  const alone = await run(sub, {});
  assert.equal(alone.status, 1);
  assert.match(alone.stderr, /no matching base import/);
});
