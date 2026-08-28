import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { GitResult, GitRunner } from "@/git.ts";
import type { WorkspaceManifest } from "@/types.ts";

import {
  flattenResolved,
  isJsonLike,
  manifestExtension,
  printRows,
  scopeManifest,
} from "@/shared.ts";

import * as initCmd from "@/commands/init.ts";
import * as validateCmd from "@/commands/validate.ts";
import * as workspacesCmd from "@/commands/workspaces.ts";
import * as envCmd from "@/commands/env.ts";
import * as checkCmd from "@/commands/check.ts";
import * as updateCmd from "@/commands/update.ts";
import * as worktreeCmd from "@/commands/worktree.ts";
import * as installCmd from "@/commands/install.ts";

// ---------------------------------------------------------------------------
// Shared helpers (src/shared.ts)
// ---------------------------------------------------------------------------

Deno.test("printRows: prints JSON when json=true", () => {
  const rows = [{ name: "a", state: "CLEAN" }];
  const spy = console.log;
  let captured: unknown;
  console.log = (...args: unknown[]) => {
    captured = args[0];
  };
  try {
    printRows(rows, true);
    assertEquals(captured, JSON.stringify(rows, null, 2));
  } finally {
    console.log = spy;
  }
});

Deno.test("scopeManifest: returns all repos when no workspace filter", () => {
  const manifest: WorkspaceManifest = {
    repositories: [
      { name: "a", url: "u", workspace: "child" },
      { name: "b", url: "u2" },
    ],
  };
  const scoped = scopeManifest({}, manifest);
  assertEquals(scoped.repositories.length, 2);
});

Deno.test("scopeManifest: filters repos by workspace name", () => {
  const manifest: WorkspaceManifest = {
    repositories: [
      { name: "a", url: "u", workspace: "child" },
      { name: "b", url: "u2" },
      { name: "c", url: "u3", workspace: "child" },
    ],
  };
  const scoped = scopeManifest({ workspace: "child" }, manifest);
  assertEquals(scoped.repositories.length, 2);
  assertEquals(scoped.repositories[0].name, "a");
  assertEquals(scoped.repositories[1].name, "c");
});

Deno.test("flattenResolved: combines resolved repos with root manifest", () => {
  const root: WorkspaceManifest = { owner: "test", repositories: [] };
  const resolved = {
    root,
    repositories: [
      { name: "a", url: "u" },
      { name: "b", url: "u2" },
    ],
  };
  const flat = flattenResolved(resolved, root);
  assertEquals(flat.repositories.length, 2);
  assertEquals(flat.owner, "test");
});

Deno.test("manifestExtension: extracts file extension", () => {
  assertEquals(manifestExtension("/path/workspace.json"), ".json");
  assertEquals(manifestExtension("/path/workspace.jsonc"), ".jsonc");
  assertEquals(manifestExtension("/path/manifest.JSON"), ".json");
});

Deno.test("isJsonLike: recognises json and jsonc", () => {
  assertEquals(isJsonLike(".json"), true);
  assertEquals(isJsonLike(".jsonc"), true);
  assertEquals(isJsonLike(".yaml"), false);
  assertEquals(isJsonLike(".toml"), false);
});

// ---------------------------------------------------------------------------
// commands/init.ts
// ---------------------------------------------------------------------------

Deno.test("init: scaffolds manifest and directories", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    const code = await initCmd.run({
      command: "init",
      manifestPath,
      positional: [],
      create: false,
      json: false,
      stale: false,
      dryRun: false,
    });
    assertEquals(code, 0);

    const stat = await Deno.stat(manifestPath);
    assertEquals(stat.isFile, true);

    const dirs = ["repos", "worktrees", "secrets"];
    for (const d of dirs) {
      const s = await Deno.stat(join(tempDir, d));
      assertEquals(s.isDirectory, true);
    }

    const content = JSON.parse(await Deno.readTextFile(manifestPath));
    assertEquals(content.schemaVersion, 4);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("init: refuses to overwrite existing manifest", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(manifestPath, "{}");
    const code = await initCmd.run({
      command: "init",
      manifestPath,
      positional: [],
      create: false,
      json: false,
      stale: false,
      dryRun: false,
    });
    assertEquals(code, 2);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("init: fails on invalid seed entries", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    // Seed with a bare string but no owner — should fail
    const code = await initCmd.run({
      command: "init",
      manifestPath,
      positional: ["some-repo"],
      create: false,
      json: false,
      stale: false,
      dryRun: false,
    });
    assertEquals(code, 2);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// commands/validate.ts
// ---------------------------------------------------------------------------

Deno.test("validate: accepts a valid manifest", () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "https://example.com/a.git" }],
  };
  const code = validateCmd.run(manifest);
  assertEquals(code, 0);
});

Deno.test("validate: rejects duplicate repository names", () => {
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
  assertEquals(threw, true);
});

// ---------------------------------------------------------------------------
// commands/workspaces.ts
// ---------------------------------------------------------------------------

Deno.test("workspaces: lists root workspace", () => {
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
      stale: false,
      dryRun: false,
    },
    resolved,
  );
  assertEquals(code, 0);
});

Deno.test("workspaces: returns JSON output", () => {
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
        stale: false,
        dryRun: false,
      },
      resolved,
    );
    const parsed = JSON.parse(captured as string);
    assertEquals(parsed.length, 1);
    assertEquals(parsed[0].name, "(root)");
  } finally {
    console.log = spy;
  }
});

// ---------------------------------------------------------------------------
// commands/env.ts
// ---------------------------------------------------------------------------

Deno.test("env: unknown subcommand returns 2", async () => {
  const manifest: WorkspaceManifest = { repositories: [] };
  const paths = {
    root: "/tmp",
    repositoriesDirectory: "/tmp/repos",
    worktreesDirectory: "/tmp/worktrees",
    secretsDirectory: "/tmp/secrets",
    resolveRepo(repo: { name: string; resolvedPath?: string }) {
      return repo.resolvedPath ?? `/tmp/repos/${repo.name}`;
    },
  };
  const g: GitRunner = {
    run(): Promise<GitResult> {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
  const code = await envCmd.run(
    {
      command: "env",
      positional: [],
      create: false,
      json: false,
      stale: false,
      dryRun: false,
    },
    manifest,
    paths,
    g,
  );
  assertEquals(code, 2);
});

// ---------------------------------------------------------------------------
// commands/check.ts
// ---------------------------------------------------------------------------

Deno.test("check: missing repo returns exit code 1", async () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "u" }],
  };
  const paths = {
    root: "/tmp",
    repositoriesDirectory: "/tmp/repos",
    worktreesDirectory: "/tmp/worktrees",
    secretsDirectory: "/tmp/secrets",
    resolveRepo(repo: { name: string; resolvedPath?: string }) {
      return repo.resolvedPath ?? `/tmp/repos/${repo.name}`;
    },
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
      stale: false,
      dryRun: false,
    },
    manifest,
    paths,
    g,
  );
  // Repo is MISSING on disk, so check returns 1 (error state)
  assertEquals(code, 1);
});

// ---------------------------------------------------------------------------
// commands/update.ts
// ---------------------------------------------------------------------------

Deno.test("update: returns 0 for up-to-date repos", async () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "u" }],
  };
  const paths = {
    root: "/tmp",
    repositoriesDirectory: "/tmp/repos",
    worktreesDirectory: "/tmp/worktrees",
    secretsDirectory: "/tmp/secrets",
    resolveRepo(repo: { name: string; resolvedPath?: string }) {
      return repo.resolvedPath ?? `/tmp/repos/${repo.name}`;
    },
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
      stale: false,
      dryRun: false,
    },
    manifest,
    paths,
    g,
  );
  assertEquals(code, 0);
});

// ---------------------------------------------------------------------------
// commands/worktree.ts
// ---------------------------------------------------------------------------

Deno.test("worktree: unknown subcommand returns 2", async () => {
  const manifest: WorkspaceManifest = { repositories: [] };
  const paths = {
    root: "/tmp",
    repositoriesDirectory: "/tmp/repos",
    worktreesDirectory: "/tmp/worktrees",
    secretsDirectory: "/tmp/secrets",
    resolveRepo(repo: { name: string; resolvedPath?: string }) {
      return repo.resolvedPath ?? `/tmp/repos/${repo.name}`;
    },
  };
  const g: GitRunner = {
    run(): Promise<GitResult> {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
  const code = await worktreeCmd.run(
    {
      command: "worktree",
      subcommand: "bogus",
      positional: [],
      create: false,
      json: false,
      stale: false,
      dryRun: false,
    },
    manifest,
    paths,
    g,
  );
  assertEquals(code, 2);
});

Deno.test("worktree: add with missing repo returns 2", async () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "u" }],
  };
  const paths = {
    root: "/tmp",
    repositoriesDirectory: "/tmp/repos",
    worktreesDirectory: "/tmp/worktrees",
    secretsDirectory: "/tmp/secrets",
    resolveRepo(repo: { name: string; resolvedPath?: string }) {
      return repo.resolvedPath ?? `/tmp/repos/${repo.name}`;
    },
  };
  const g: GitRunner = {
    run(): Promise<GitResult> {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
  const code = await worktreeCmd.run(
    {
      command: "worktree",
      subcommand: "add",
      positional: ["nonexistent", "feat"],
      create: false,
      json: false,
      stale: false,
      dryRun: false,
    },
    manifest,
    paths,
    g,
  );
  assertEquals(code, 2);
});

Deno.test("worktree: list with no repos returns 0", async () => {
  const manifest: WorkspaceManifest = { repositories: [] };
  const paths = {
    root: "/tmp",
    repositoriesDirectory: "/tmp/repos",
    worktreesDirectory: "/tmp/worktrees",
    secretsDirectory: "/tmp/secrets",
    resolveRepo(repo: { name: string; resolvedPath?: string }) {
      return repo.resolvedPath ?? `/tmp/repos/${repo.name}`;
    },
  };
  const g: GitRunner = {
    run(): Promise<GitResult> {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
  const code = await worktreeCmd.run(
    {
      command: "worktree",
      subcommand: "list",
      positional: [],
      create: false,
      json: false,
      stale: false,
      dryRun: false,
    },
    manifest,
    paths,
    g,
  );
  assertEquals(code, 0);
});

// ---------------------------------------------------------------------------
// commands/install.ts
// ---------------------------------------------------------------------------

Deno.test("install: clones all missing repos", async () => {
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

  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPathLocal = join(tempDir, "workspace.json");
    await Deno.writeTextFile(manifestPathLocal, JSON.stringify(manifest));

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
        stale: false,
        dryRun: false,
      },
      localManifest,
      manifestPathLocal,
      g,
    );
    assertEquals(code, 0);
    assertEquals(cloneUrls.length, 2);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("install: only clones specified subset", async () => {
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

  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

    const code = await installCmd.run(
      {
        command: "install",
        subcommand: "a",
        positional: [],
        create: false,
        json: false,
        stale: false,
        dryRun: false,
      },
      manifest,
      manifestPath,
      g,
    );
    assertEquals(code, 0);
    assertEquals(cloneUrls.length, 1);
    assertEquals(cloneUrls[0], "https://example.com/a.git");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("install: unknown repo returns 1", async () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "https://example.com/a.git" }],
  };

  const g: GitRunner = {
    run(): Promise<GitResult> {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };

  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

    const code = await installCmd.run(
      {
        command: "install",
        subcommand: "nonexistent",
        positional: [],
        create: false,
        json: false,
        stale: false,
        dryRun: false,
      },
      manifest,
      manifestPath,
      g,
    );
    assertEquals(code, 1);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
