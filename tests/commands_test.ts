import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, stat, writeFile } from "node:fs/promises";
import { makeTempDir, readText } from "./helpers.ts";
import { join } from "@std/path";
import type { GitResult, GitRunner } from "@/git.ts";
import type { WorkspaceManifest } from "@/types.ts";

import {
  flattenResolved,
  manifestExtension,
  printRows,
  scopeManifest,
} from "@/shared.ts";
import { manifestPaths } from "@/manifest-paths.ts";

import * as initCmd from "@/commands/init.ts";
import * as validateCmd from "@/commands/validate.ts";
import * as workspacesCmd from "@/commands/workspaces.ts";
import * as checkCmd from "@/commands/check.ts";
import * as updateCmd from "@/commands/update.ts";
import * as installCmd from "@/commands/install.ts";

// ---------------------------------------------------------------------------
// Shared helpers (src/shared.ts)
// ---------------------------------------------------------------------------

test("printRows: prints JSON when json=true", () => {
  const rows = [{ name: "a", state: "CLEAN" }];
  const spy = console.log;
  let captured: unknown;
  console.log = (...args: unknown[]) => {
    captured = args[0];
  };
  try {
    printRows(rows, true);
    assert.deepEqual(captured, JSON.stringify(rows, null, 2));
  } finally {
    console.log = spy;
  }
});

test("scopeManifest: returns all repos when no workspace filter", () => {
  const manifest: WorkspaceManifest = {
    repositories: [
      { name: "a", url: "u", workspace: "child" },
      { name: "b", url: "u2" },
    ],
  };
  const scoped = scopeManifest({}, manifest);
  assert.deepEqual(scoped.repositories.length, 2);
});

test("scopeManifest: filters repos by workspace name", () => {
  const manifest: WorkspaceManifest = {
    repositories: [
      { name: "a", url: "u", workspace: "child" },
      { name: "b", url: "u2" },
      { name: "c", url: "u3", workspace: "child" },
    ],
  };
  const scoped = scopeManifest({ workspace: "child" }, manifest);
  assert.deepEqual(scoped.repositories.length, 2);
  assert.deepEqual(scoped.repositories[0].name, "a");
  assert.deepEqual(scoped.repositories[1].name, "c");
});

test("flattenResolved: combines resolved repos with root manifest", () => {
  const root: WorkspaceManifest = { owner: "test", repositories: [] };
  const resolved = {
    root,
    repositories: [
      { name: "a", url: "u" },
      { name: "b", url: "u2" },
    ],
  };
  const flat = flattenResolved(resolved, root);
  assert.deepEqual(flat.repositories.length, 2);
  assert.deepEqual(flat.owner, "test");
});

test("manifestExtension: extracts file extension", () => {
  assert.deepEqual(manifestExtension("/path/workspace.json"), ".json");
  assert.deepEqual(manifestExtension("/path/manifest.JSON"), ".json");
});

// ---------------------------------------------------------------------------
// commands/init.ts
// ---------------------------------------------------------------------------

test("init: scaffolds manifest and directories", async () => {
  const tempDir = await makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    const code = await initCmd.run({
      command: "init",
      manifestPath,
      positional: [],
      create: false,
      json: false,
      dryRun: false,
    });
    assert.deepEqual(code, 0);

    const manifestStat = await stat(manifestPath);
    assert(manifestStat.isFile());

    const dirs = ["repos"];
    for (const d of dirs) {
      const s = await stat(join(tempDir, d));
      assert(s.isDirectory());
    }

    const content = JSON.parse(await readText(manifestPath));
    assert.deepEqual(content.schemaVersion, 4);
  } finally {
    await rm(tempDir, { recursive: true });
  }
});

test("init: refuses to overwrite existing manifest", async () => {
  const tempDir = await makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    await writeFile(manifestPath, "{}");
    const code = await initCmd.run({
      command: "init",
      manifestPath,
      positional: [],
      create: false,
      json: false,
      dryRun: false,
    });
    assert.deepEqual(code, 2);
  } finally {
    await rm(tempDir, { recursive: true });
  }
});

test("init: fails on invalid seed entries", async () => {
  const tempDir = await makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    // Seed with a bare string but no owner — should fail
    const code = await initCmd.run({
      command: "init",
      manifestPath,
      positional: ["some-repo"],
      create: false,
      json: false,
      dryRun: false,
    });
    assert.deepEqual(code, 2);
  } finally {
    await rm(tempDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// commands/validate.ts
// ---------------------------------------------------------------------------

test("validate: accepts a valid manifest", () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "https://example.com/a.git" }],
  };
  const code = validateCmd.run(manifest);
  assert.deepEqual(code, 0);
});

test("validate: rejects duplicate repository names", () => {
  const manifest: WorkspaceManifest = {
    repositories: [
      { name: "a", url: "https://example.com/a.git" },
      { name: "a", url: "https://example.com/b.git" },
    ],
  };
  let threw = false;
  try {
    validateCmd.run(manifest);
  } catch {
    threw = true;
  }
  assert.deepEqual(threw, true);
});

// ---------------------------------------------------------------------------
// commands/workspaces.ts
// ---------------------------------------------------------------------------

test("workspaces: lists root workspace", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    repositories: [
      { name: "a", url: "u" },
      { name: "b", url: "u2" },
    ],
  };
  const code = workspacesCmd.run(
    {
      command: "workspaces",
      positional: [],
      create: false,
      json: false,
      dryRun: false,
    },
    resolved,
  );
  assert.deepEqual(code, 0);
});

test("workspaces: returns JSON output", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    repositories: [{ name: "a", url: "u" }],
  };
  let captured: unknown;
  const spy = console.log;
  console.log = (...args: unknown[]) => {
    captured = args[0];
  };
  try {
    workspacesCmd.run(
      {
        command: "workspaces",
        positional: [],
        create: false,
        json: true,
        dryRun: false,
      },
      resolved,
    );
    const parsed = JSON.parse(captured as string);
    assert.deepEqual(parsed.length, 1);
    assert.deepEqual(parsed[0].name, "(root)");
  } finally {
    console.log = spy;
  }
});

// ---------------------------------------------------------------------------
// commands/env.ts
// ---------------------------------------------------------------------------

test("check: missing repo returns exit code 1", async () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "u" }],
  };
  const paths = {
    root: "/tmp",
    repositoriesDirectory: "/tmp/repos",
  };
  const g: GitRunner = {
    run(): Promise<GitResult> {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
  const code = await checkCmd.run(
    {
      command: "check",
      positional: [],
      create: false,
      json: false,
      dryRun: false,
    },
    manifest,
    paths,
    g,
  );
  // Repo is MISSING on disk, so check returns 1 (error state)
  assert.deepEqual(code, 1);
});

// ---------------------------------------------------------------------------
// commands/update.ts
// ---------------------------------------------------------------------------

test("update: returns 0 for up-to-date repos", async () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "u" }],
  };
  const paths = {
    root: "/tmp",
    repositoriesDirectory: "/tmp/repos",
  };
  const g: GitRunner = {
    run(_args: string[], _cwd?: string): Promise<GitResult> {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
  const code = await updateCmd.run(
    {
      command: "update",
      positional: [],
      create: false,
      json: false,
      dryRun: false,
    },
    manifest,
    paths,
    g,
  );
  assert.deepEqual(code, 0);
});

// ---------------------------------------------------------------------------
// commands/worktree.ts
// ---------------------------------------------------------------------------

test("install: clones all missing repos", async () => {
  const manifest: WorkspaceManifest = {
    repositories: [
      { name: "a", url: "https://example.com/a.git" },
      { name: "b", url: "https://example.com/b.git" },
    ],
  };
  const cloneUrls: string[] = [];
  const g: GitRunner = {
    run(args: string[], _cwd?: string): Promise<GitResult> {
      if (args[0] === "clone") {
        cloneUrls.push(args[1]);
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };

  const tempDir = await makeTempDir();
  try {
    const manifestPathLocal = join(tempDir, "workspace.json");
    await writeFile(manifestPathLocal, JSON.stringify(manifest));

    const localManifest: WorkspaceManifest = {
      repositories: [
        { name: "a", url: "https://example.com/a.git" },
        { name: "b", url: "https://example.com/b.git" },
      ],
    };

    const code = await installCmd.run(
      {
        command: "install",
        positional: [],
        create: false,
        json: false,
        dryRun: false,
      },
      localManifest,
      manifestPaths(localManifest, manifestPathLocal),
      g,
    );
    assert.deepEqual(code, 0);
    assert.deepEqual(cloneUrls.length, 2);
  } finally {
    await rm(tempDir, { recursive: true });
  }
});

test("install: only clones specified subset", async () => {
  const manifest: WorkspaceManifest = {
    repositories: [
      { name: "a", url: "https://example.com/a.git" },
      { name: "b", url: "https://example.com/b.git" },
    ],
  };

  const cloneUrls: string[] = [];
  const g: GitRunner = {
    run(args: string[], _cwd?: string): Promise<GitResult> {
      if (args[0] === "clone") {
        cloneUrls.push(args[1]);
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };

  const tempDir = await makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    await writeFile(manifestPath, JSON.stringify(manifest));

    const code = await installCmd.run(
      {
        command: "install",
        subcommand: "a",
        positional: [],
        create: false,
        json: false,
        dryRun: false,
      },
      manifest,
      manifestPaths(manifest, manifestPath),
      g,
    );
    assert.deepEqual(code, 0);
    assert.deepEqual(cloneUrls.length, 1);
    assert.deepEqual(cloneUrls[0], "https://example.com/a.git");
  } finally {
    await rm(tempDir, { recursive: true });
  }
});

test("install: unknown repo returns 1", async () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "https://example.com/a.git" }],
  };

  const g: GitRunner = {
    run(): Promise<GitResult> {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };

  const tempDir = await makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    await writeFile(manifestPath, JSON.stringify(manifest));

    const code = await installCmd.run(
      {
        command: "install",
        subcommand: "nonexistent",
        positional: [],
        create: false,
        json: false,
        dryRun: false,
      },
      manifest,
      manifestPaths(manifest, manifestPath),
      g,
    );
    assert.deepEqual(code, 1);
  } finally {
    await rm(tempDir, { recursive: true });
  }
});
