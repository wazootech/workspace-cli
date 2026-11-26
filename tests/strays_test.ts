import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { makeTempDir } from "./helpers.ts";
import { join } from "@std/path";
import { run } from "@/cli.ts";
import { collectStatus, hasErrors } from "@/status.ts";
import { rootStrayRows } from "@/strays.ts";
import type { ManifestPaths } from "@/manifest.ts";
import type { RepoStatus } from "@/types.ts";
import { g, makeRepoWithMain, removeTempDir } from "./sweep_helpers.ts";

function layout(dir: string, workspaces?: string): ManifestPaths {
  return {
    root: dir,
    repositoriesDirectory: join(dir, "repos"),
    workspacesDirectory: workspaces && join(dir, workspaces),
  };
}

async function withTempDir(body: (dir: string) => Promise<void>) {
  const dir = await makeTempDir();
  try {
    await body(dir);
  } finally {
    await removeTempDir(dir);
  }
}

function byName(rows: RepoStatus[], name: string): RepoStatus | undefined {
  return rows.find((r) => r.name === name);
}

test("strays: non-git directories and files under repos are reported", async () => {
  await withTempDir(async (dir) => {
    const repos = join(dir, "repos");
    await mkdir(join(repos, "leftover", "wiki"), { recursive: true });
    await mkdir(join(repos, "empty"));
    await writeFile(join(repos, "notes.zip"), "x");
    await writeFile(join(repos, ".gitkeep"), "");

    const rows = await collectStatus(g, { repositories: [] }, layout(dir));
    assert.deepEqual(byName(rows, "(unmanaged) leftover")?.state, "UNMANAGED");
    assert.deepEqual(
      byName(rows, "(unmanaged) leftover")?.detail,
      "directory, not a Git checkout",
    );
    assert.deepEqual(
      byName(rows, "(unmanaged) empty")?.detail,
      "empty directory, not a Git checkout",
    );
    assert.deepEqual(
      byName(rows, "(unmanaged) notes.zip")?.detail,
      "stray file",
    );
    assert(!byName(rows, "(unmanaged) .gitkeep"), ".gitkeep is ignored");
    assert.deepEqual(hasErrors(rows), false, "strays are warnings by default");
    assert.deepEqual(hasErrors(rows, { strict: true }), true);
  });
});

test("strays: workspacesDirectory is scanned too", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "workspaces", "orphan"), { recursive: true });
    await mkdir(join(dir, "workspaces", "declared"), { recursive: true });
    const rows = await collectStatus(
      g,
      {
        repositories: [
          {
            name: "declared",
            url: "u",
            isWorkspace: true,
            resolvedPath: join(dir, "workspaces", "declared"),
          },
        ],
      },
      layout(dir, "workspaces"),
    );
    assert.deepEqual(byName(rows, "(unmanaged) orphan")?.state, "UNMANAGED");
    assert(!byName(rows, "(unmanaged) declared"));
  });
});

test("strays: a directory that contains declared checkouts is not a stray", async () => {
  await withTempDir(async (dir) => {
    const nested = join(dir, "repos", "group", "inner");
    await mkdir(nested, { recursive: true });
    const rows = await collectStatus(
      g,
      { repositories: [{ name: "inner", url: "u", resolvedPath: nested }] },
      layout(dir),
    );
    assert(!byName(rows, "(unmanaged) group"));
  });
});

test("strays: unmanaged git checkout keeps its state and fails under --strict", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "repos"));
    await makeRepoWithMain(dir, "a");
    await g.run(["clone", join(dir, "a.git"), join(dir, "repos", "x")]);
    const rows = await collectStatus(g, { repositories: [] }, layout(dir));
    const row = byName(rows, "(unmanaged) x");
    assert.deepEqual(row?.state, "CLEAN");
    assert.deepEqual(row?.unmanaged, true);
    assert.deepEqual(hasErrors(rows), false);
    assert.deepEqual(hasErrors(rows, { strict: true }), true);
  });
});

test("strays: root git checkouts are flagged, tooling and managed dirs are not", async () => {
  await withTempDir(async (dir) => {
    for (const name of ["memory", "scratch", "tmp", ".letta", "plain"]) {
      await mkdir(join(dir, name, ".git"), { recursive: true });
    }
    await mkdir(join(dir, "plain-dir"));
    await mkdir(join(dir, "repos"));
    const rows = await collectStatus(
      g,
      { repositories: [{ name: "memory", url: "u" }] },
      layout(dir),
      { includeRoot: true },
    );
    assert.deepEqual(
      byName(rows, "(stray) memory")?.detail,
      'unmanaged duplicate of registered repo "memory"',
    );
    assert.deepEqual(
      byName(rows, "(stray) scratch")?.detail,
      "unmanaged Git checkout at the workspace root",
    );
    for (const ignored of ["tmp", ".letta", "plain-dir"]) {
      assert(!byName(rows, `(stray) ${ignored}`), `${ignored} not flagged`);
    }
    // The declared "memory" is not cloned here (MISSING); the strays alone
    // must not fail the run.
    assert.deepEqual(hasErrors(rows.filter((r) => r.unmanaged)), false);
  });
});

test("strays: a declared checkout at the root is not a stray", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "memory", ".git"), { recursive: true });
    const rows = await collectStatus(
      g,
      {
        repositories: [
          {
            name: "memory",
            url: "u",
            resolvedPath: join(dir, "memory"),
          },
        ],
      },
      layout(dir),
    );
    assert(!byName(rows, "(stray) memory"));
  });
});

test("strays: scoped runs skip root strays but judge against all repos", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "scratch", ".git"), { recursive: true });
    await mkdir(join(dir, "repos", "other", ".git"), { recursive: true });
    const other = { name: "other", url: "u" };
    const rows = await collectStatus(g, { repositories: [] }, layout(dir), {
      includeRoot: false,
      knownRepositories: [other],
    });
    assert(!byName(rows, "(stray) scratch"));
    assert(!byName(rows, "(unmanaged) other"));
  });
});

test("install: warns about a root duplicate of a target repo", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "memory", ".git"), { recursive: true });
    const repo = { name: "memory", url: "u" };
    const rows = await rootStrayRows([repo, { name: "wiki", url: "u" }], {
      root: dir,
      repositoriesDirectory: join(dir, "repos"),
    });
    assert.deepEqual(rows.length, 1);
    assert.deepEqual(rows[0].name, "(stray) memory");
    assert.deepEqual(rows[0].state, "UNMANAGED");
  });
});

async function checkFixture(dir: string): Promise<string> {
  const manifest = join(dir, "workspace.json");
  await writeFile(
    manifest,
    JSON.stringify({ schemaVersion: 4, repositories: [] }),
  );
  await mkdir(join(dir, "repos", "junk"), { recursive: true });
  return manifest;
}

test("check: stray rows exit 0 by default and 1 under --strict", async () => {
  await withTempDir(async (dir) => {
    const manifest = await checkFixture(dir);
    const quiet = console.log;
    console.log = () => {};
    try {
      assert.deepEqual(await run(["check", "--manifest", manifest]), 0);
      assert.deepEqual(
        await run(["check", "--manifest", manifest, "--strict"]),
        1,
      );
    } finally {
      console.log = quiet;
    }
  });
});
