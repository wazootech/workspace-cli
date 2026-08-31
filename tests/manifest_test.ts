import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  detectConflicts,
  findDefaultManifestPath,
  findManifestWalkingUp,
  listWorkspaces,
  loadManifest,
  manifestPaths,
  resolveRepositoryPath,
  resolveWorkspaceTree,
  validateManifest,
  validateManifestText,
} from "@/manifest.ts";
import { validateSafeName } from "@/manifest.ts";
import type { WorkspaceManifest } from "@/types.ts";

Deno.test("validateManifest accepts a valid manifest", () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "https://example.com/a.git" }],
  };
  validateManifest(manifest);
});

Deno.test("validateManifest rejects duplicate repository names", () => {
  const manifest: WorkspaceManifest = {
    repositories: [
      { name: "a", url: "https://example.com/a.git" },
      { name: "a", url: "https://example.com/a2.git" },
    ],
  };
  assertThrows(() => validateManifest(manifest), Error, "Duplicate");
});

Deno.test("validateManifest rejects a repository without a url", () => {
  const manifest = {
    repositories: [{ name: "a" }],
  } as unknown as WorkspaceManifest;
  assertThrows(
    () => validateManifest(manifest),
    Error,
    "either bare strings or",
  );
});

Deno.test("validateManifest rejects a newer schema version", () => {
  const manifest: WorkspaceManifest = { schemaVersion: 99, repositories: [] };
  assertThrows(() => validateManifest(manifest), Error, "newer than supported");
});

Deno.test("loadManifest rejects yaml manifests (unsupported format)", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.yaml");
    await Deno.writeTextFile(
      manifestPath,
      `schemaVersion: 4\nowner: acme\nrepositories:\n  - shared-reference\n`,
    );

    await assertRejects(
      () => loadManifest(manifestPath),
      Error,
      "Unsupported manifest format",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest rejects unsupported manifest extensions", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.toml");
    await Deno.writeTextFile(manifestPath, "repositories = []");
    await assertRejects(
      () => loadManifest(manifestPath),
      Error,
      "Unsupported manifest format",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest rejects yaml documents (unsupported format)", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.yaml");
    await Deno.writeTextFile(manifestPath, "repositories: 3\n");
    await assertRejects(
      () => loadManifest(manifestPath),
      Error,
      "Unsupported manifest format",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findDefaultManifestPath discovers json manifests", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const jsonPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(jsonPath, "{}\n");
    assertEquals(await findDefaultManifestPath(tempDir), jsonPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("validateManifest accepts schema version 4", () => {
  validateManifest({ schemaVersion: 4, repositories: [] });
});

Deno.test("validateManifest rejects schema version 5", () => {
  const manifest: WorkspaceManifest = { schemaVersion: 5, repositories: [] };
  assertThrows(() => validateManifest(manifest), Error, "newer than supported");
});

Deno.test("manifestPaths applies defaults under the manifest directory", () => {
  const manifest: WorkspaceManifest = { repositories: [] };
  const manifestFile = join(Deno.cwd(), "ws", "repos.json");
  const paths = manifestPaths(manifest, manifestFile);
  assertEquals(paths.root, dirname(manifestFile));
  assertEquals(
    paths.repositoriesDirectory,
    join(dirname(manifestFile), "repos"),
  );
  assertEquals(
    paths.worktreesDirectory,
    join(dirname(manifestFile), "worktrees"),
  );
  assertEquals(paths.secretsDirectory, join(dirname(manifestFile), "secrets"));
});

Deno.test("manifestPaths resolves relative workspaceRoot from manifest directory", () => {
  const manifest: WorkspaceManifest = { workspaceRoot: "..", repositories: [] };
  const manifestFile = join(Deno.cwd(), "ws", "repos.json");
  const paths = manifestPaths(manifest, manifestFile);
  assertEquals(paths.root, dirname(dirname(manifestFile)));
});

Deno.test("manifestPaths honors absolute workspaceRoot", () => {
  const manifest: WorkspaceManifest = {
    workspaceRoot: Deno.build.os === "windows" ? "C:\\wazoo" : "/wazoo",
    repositories: [],
  };
  const manifestFile = Deno.build.os === "windows"
    ? "C:\\ws\\repos.json"
    : "/ws/repos.json";
  const paths = manifestPaths(manifest, manifestFile);
  assertEquals(
    paths.root,
    Deno.build.os === "windows" ? "C:\\wazoo" : "/wazoo",
  );
});

Deno.test("validateManifest rejects invalid repo names or traversal", () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "../traversal", url: "https://example.com/a.git" }],
  };
  assertThrows(
    () => validateManifest(manifest),
    Error,
    "invalid characters or path traversal",
  );
});

Deno.test("validateManifest accepts dotted and underscored repo names", () => {
  const manifest: WorkspaceManifest = {
    repositories: [
      { name: ".github", url: "https://github.com/acme/.github.git" },
      {
        name: "docs.wazoo.dev",
        url: "https://github.com/acme/docs.wazoo.dev.git",
      },
      { name: "my_repo", url: "https://github.com/acme/my_repo.git" },
    ],
  };
  validateManifest(manifest);
});

Deno.test("validateManifest rejects .git suffix and reserved names", () => {
  const badNames = ["ends-with.git", ".", ".."];
  for (const name of badNames) {
    assertThrows(
      () =>
        validateManifest({
          repositories: [{ name, url: `https://github.com/acme/${name}.git` }],
        }),
      Error,
    );
  }
});

Deno.test("loadManifest accepts .github and dotted repo shorthand", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 4,
        owner: "wazootech",
        repositories: [".github", "docs.wazoo.dev", "wazoo.dev", "my_repo"],
      }),
    );

    const manifest = await loadManifest(manifestPath);
    assertEquals(manifest.repositories.length, 4);
    assertEquals(manifest.repositories[0].name, ".github");
    assertEquals(
      manifest.repositories[0].url,
      "https://github.com/wazootech/.github",
    );
    assertEquals(manifest.repositories[1].name, "docs.wazoo.dev");
    assertEquals(manifest.repositories[3].name, "my_repo");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findDefaultManifestPath defaults to workspace.json", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // When no manifest exists, defaults to workspace.json
    assertEquals(
      await findDefaultManifestPath(tempDir),
      join(tempDir, "workspace.json"),
    );

    // If workspace.json exists, resolves it
    const workspacePath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(workspacePath, "{}");
    assertEquals(await findDefaultManifestPath(tempDir), workspacePath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest expands bare-string entries against owner", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 4,
        owner: "ethanthatonekid",
        repositories: ["etok", "memsdk"],
      }),
    );

    const manifest = await loadManifest(manifestPath);
    assertEquals(manifest.owner, "ethanthatonekid");
    assertEquals(manifest.repositories.length, 2);
    assertEquals(manifest.repositories[0].name, "etok");
    assertEquals(
      manifest.repositories[0].url,
      "https://github.com/ethanthatonekid/etok",
    );
    assertEquals(
      manifest.repositories[1].url,
      "https://github.com/ethanthatonekid/memsdk",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest rejects a bare-string entry without an owner", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({ repositories: ["etok"] }),
    );
    await assertRejects(
      () => loadManifest(manifestPath),
      Error,
      "Invalid repository owner",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest keeps object entries untouched by owner", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        owner: "wazootech",
        repositories: [
          { name: "elsewhere", url: "https://gitlab.com/other/elsewhere.git" },
        ],
      }),
    );

    const manifest = await loadManifest(manifestPath);
    assertEquals(
      manifest.repositories[0].url,
      "https://gitlab.com/other/elsewhere.git",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest expands owner/name slash strings without top-level owner", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({ repositories: ["wazootech/memsdk"] }),
    );

    const manifest = await loadManifest(manifestPath);
    assertEquals(manifest.repositories[0].name, "memsdk");
    assertEquals(
      manifest.repositories[0].url,
      "https://github.com/wazootech/memsdk",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest lets inline owner override the top-level owner", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        owner: "ethanthatonekid",
        repositories: ["wazootech/memsdk", "etok"],
      }),
    );

    const manifest = await loadManifest(manifestPath);
    assertEquals(
      manifest.repositories[0].url,
      "https://github.com/wazootech/memsdk",
    );
    assertEquals(
      manifest.repositories[1].url,
      "https://github.com/ethanthatonekid/etok",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest rejects shorthand strings with multiple slashes", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({ repositories: ["a/b/c"] }),
    );
    await assertRejects(
      () => loadManifest(manifestPath),
      Error,
      "Unable to parse repository string",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest expands { name, owner } object shorthands against host", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        host: "gitlab.com",
        repositories: [{ name: "memsdk", owner: "wazootech" }],
      }),
    );

    const manifest = await loadManifest(manifestPath);
    assertEquals(manifest.repositories[0].name, "memsdk");
    assertEquals(
      manifest.repositories[0].url,
      "https://gitlab.com/wazootech/memsdk",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest rejects entries setting both url and owner", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        repositories: [{
          name: "a",
          url: "https://example.com/a.git",
          owner: "acme",
        }],
      }),
    );
    await assertRejects(
      () => loadManifest(manifestPath),
      Error,
      "mutually exclusive",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest rejects a non-hostname host value", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        host: "https://github.com",
        repositories: [],
      }),
    );
    await assertRejects(
      () => loadManifest(manifestPath),
      Error,
      "must be a bare hostname",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest rejects a legacy vaultDirectory key", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({ repositories: [], vaultDirectory: "secrets" }),
    );
    await assertRejects(
      () => loadManifest(manifestPath),
      Error,
      'renamed to "secretsDirectory" in schema v4',
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadManifest rejects a legacy workspaces array with migration hint", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        repositories: [],
        workspaces: [{ name: "child", path: "child/workspace.json" }],
      }),
    );
    await assertRejects(
      () => loadManifest(manifestPath),
      Error,
      '"workspaces" was removed in schema v4',
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorkspaceTree resolves object entries against child path", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const parentManifestPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          { name: "explicit", url: "https://example.com/explicit.git" },
        ],
      }),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(parentManifestPath);
    const resolved = await resolveWorkspaceTree(manifest, parentManifestPath);

    assertEquals(resolved.repositories.length, 1);
    assertEquals(resolved.repositories[0].name, "explicit");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("detectConflicts finds duplicate repo names across workspaces", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    repositories: [
      { name: "shared", url: "u", workspace: undefined },
      { name: "shared", url: "u2", workspace: "child-a" },
      { name: "unique", url: "u3", workspace: "child-b" },
    ],
  };
  const conflicts = detectConflicts(resolved);
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0].repoName, "shared");
  assertEquals(conflicts[0].claimedBy, ["(root)", "child-a"]);
});

Deno.test("detectConflicts returns empty when no conflicts", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    repositories: [
      { name: "a", url: "u", workspace: undefined },
      { name: "b", url: "u2", workspace: "child" },
    ],
  };
  assertEquals(detectConflicts(resolved).length, 0);
});

Deno.test("listWorkspaces returns root with all repos", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    repositories: [
      { name: "a", url: "u", workspace: undefined },
      { name: "b", url: "u2", workspace: undefined },
    ],
  };
  const ws = listWorkspaces(resolved);
  assertEquals(ws.length, 1);
  assertEquals(ws[0], { name: "(root)", repos: 2, child: false });
});

Deno.test("validateManifestText expands bare-string shorthand with owner", () => {
  const raw = JSON.stringify({
    owner: "acme",
    repositories: ["api"],
  });
  const manifest = validateManifestText(raw, "/fake/workspace.json");
  assertEquals(manifest.repositories[0].name, "api");
  assertEquals(
    manifest.repositories[0].url,
    "https://github.com/acme/api",
  );
});

Deno.test("validateManifestText expands owner/name inline shorthand", () => {
  const raw = JSON.stringify({
    repositories: ["acme/api"],
  });
  const manifest = validateManifestText(raw, "/fake/workspace.json");
  assertEquals(manifest.repositories[0].name, "api");
  assertEquals(
    manifest.repositories[0].url,
    "https://github.com/acme/api",
  );
});

Deno.test("validateManifestText inline owner overrides top-level owner", () => {
  const raw = JSON.stringify({
    owner: "acme",
    repositories: ["other/repo"],
  });
  const manifest = validateManifestText(raw, "/fake/workspace.json");
  assertEquals(
    manifest.repositories[0].url,
    "https://github.com/other/repo",
  );
});

Deno.test("validateManifestText expands shorthand against custom host", () => {
  const raw = JSON.stringify({
    host: "gitlab.com",
    owner: "acme",
    repositories: ["api"],
  });
  const manifest = validateManifestText(raw, "/fake/workspace.json");
  assertEquals(
    manifest.repositories[0].url,
    "https://gitlab.com/acme/api",
  );
});

Deno.test("validateManifestText rejects shorthand without owner", () => {
  const raw = JSON.stringify({
    repositories: ["api"],
  });
  assertThrows(
    () => validateManifestText(raw, "/fake/workspace.json"),
    Error,
    "Invalid repository owner",
  );
});

Deno.test("validateManifestText rejects multiple slashes in shorthand", () => {
  const raw = JSON.stringify({
    repositories: ["a/b/c"],
  });
  assertThrows(
    () => validateManifestText(raw, "/fake/workspace.json"),
    Error,
    "Unable to parse repository string",
  );
});

Deno.test("validateManifestText rejects shorthand with empty owner half", () => {
  const raw = JSON.stringify({
    repositories: ["/api"],
  });
  assertThrows(
    () => validateManifestText(raw, "/fake/workspace.json"),
    Error,
    "Unable to parse repository string",
  );
});

Deno.test("validateManifestText rejects shorthand with empty name half", () => {
  const raw = JSON.stringify({
    repositories: ["acme/"],
  });
  assertThrows(
    () => validateManifestText(raw, "/fake/workspace.json"),
    Error,
    "Unable to parse repository string",
  );
});

Deno.test("validateManifestText expands { name, owner } object shorthand", () => {
  const raw = JSON.stringify({
    host: "gitlab.com",
    repositories: [{ name: "api", owner: "acme" }],
  });
  const manifest = validateManifestText(raw, "/fake/workspace.json");
  assertEquals(manifest.repositories[0].name, "api");
  assertEquals(
    manifest.repositories[0].url,
    "https://gitlab.com/acme/api",
  );
});

Deno.test("resolveRepositoryPath computes default path from reposDirectory", () => {
  const manifest: WorkspaceManifest = { repositories: [] };
  const wsDir = join(Deno.cwd(), "ws");
  const paths = manifestPaths(manifest, join(wsDir, "workspace.json"));
  assertEquals(
    resolveRepositoryPath({ name: "api" }, paths),
    join(wsDir, "repos", "api"),
  );
});

Deno.test("resolveRepositoryPath uses pre-set resolvedPath when available", () => {
  const manifest: WorkspaceManifest = { repositories: [] };
  const wsDir = join(Deno.cwd(), "ws");
  const paths = manifestPaths(manifest, join(wsDir, "workspace.json"));
  const expected = Deno.build.os === "windows"
    ? "C:\\custom\\path"
    : "/custom/path";
  assertEquals(
    resolveRepositoryPath({ name: "api", resolvedPath: expected }, paths),
    expected,
  );
});

Deno.test("resolveRepositoryPath respects custom repositoriesDirectory", () => {
  const manifest: WorkspaceManifest = {
    repositoriesDirectory: "libs",
    repositories: [],
  };
  const wsDir = join(Deno.cwd(), "ws");
  const paths = manifestPaths(manifest, join(wsDir, "workspace.json"));
  assertEquals(
    resolveRepositoryPath({ name: "api" }, paths),
    join(wsDir, "libs", "api"),
  );
});

Deno.test("resolveWorkspaceTree computes resolvedPath for each repo", () => {
  const manifest: WorkspaceManifest = {
    repositories: [
      { name: "a", url: "https://example.com/a.git" },
      { name: "b", url: "https://example.com/b.git" },
    ],
  };
  const wsDir = join(Deno.cwd(), "ws");
  const resolved = resolveWorkspaceTree(
    manifest,
    join(wsDir, "workspace.json"),
  );
  assertEquals(resolved.repositories.length, 2);
  assertEquals(
    resolved.repositories[0].resolvedPath,
    join(wsDir, "repos", "a"),
  );
  assertEquals(
    resolved.repositories[1].resolvedPath,
    join(wsDir, "repos", "b"),
  );
});

Deno.test("resolveWorkspaceTree sets workspace to undefined for root repos", () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "u" }],
  };
  const resolved = resolveWorkspaceTree(manifest, "/ws/workspace.json");
  assertEquals(resolved.repositories[0].workspace, undefined);
});

Deno.test("resolveWorkspaceTree uses custom repositoriesDirectory", () => {
  const manifest: WorkspaceManifest = {
    repositoriesDirectory: "libs",
    repositories: [{ name: "a", url: "u" }],
  };
  const wsDir = join(Deno.cwd(), "ws");
  const resolved = resolveWorkspaceTree(
    manifest,
    join(wsDir, "workspace.json"),
  );
  assertEquals(
    resolved.repositories[0].resolvedPath,
    join(wsDir, "libs", "a"),
  );
});

Deno.test("resolveWorkspaceTree preserves pre-set resolvedPath", () => {
  const expected = Deno.build.os === "windows" ? "C:\\opt\\a" : "/opt/a";
  const manifest: WorkspaceManifest = {
    repositories: [
      { name: "a", url: "u", resolvedPath: expected },
    ],
  };
  const wsDir = join(Deno.cwd(), "ws");
  const resolved = resolveWorkspaceTree(
    manifest,
    join(wsDir, "workspace.json"),
  );
  assertEquals(resolved.repositories[0].resolvedPath, expected);
});

Deno.test("manifestPaths resolves relative repositoriesDirectory", () => {
  const manifest: WorkspaceManifest = {
    repositoriesDirectory: "libs",
    repositories: [],
  };
  const wsDir = join(Deno.cwd(), "ws");
  const paths = manifestPaths(manifest, join(wsDir, "workspace.json"));
  assertEquals(paths.repositoriesDirectory, join(wsDir, "libs"));
});

Deno.test("manifestPaths honors absolute worktreesDirectory", () => {
  const absWt = Deno.build.os === "windows" ? "C:\\tmp\\wt" : "/tmp/wt";
  const manifest: WorkspaceManifest = {
    worktreesDirectory: absWt,
    repositories: [],
  };
  const wsDir = join(Deno.cwd(), "ws");
  const paths = manifestPaths(manifest, join(wsDir, "workspace.json"));
  assertEquals(paths.worktreesDirectory, absWt);
});

Deno.test("manifestPaths resolves relative secretsDirectory", () => {
  const manifest: WorkspaceManifest = {
    secretsDirectory: ".secrets",
    repositories: [],
  };
  const wsDir = join(Deno.cwd(), "ws");
  const paths = manifestPaths(manifest, join(wsDir, "workspace.json"));
  assertEquals(paths.secretsDirectory, join(wsDir, ".secrets"));
});

Deno.test("validateSafeName", async (t) => {
  const validCases = ["my-repo", "repo_name", "a.b", "123"];
  for (const name of validCases) {
    await t.step(`accepts "${name}"`, () => {
      validateSafeName(name);
    });
  }

  const errorCases: { input: string; pattern: string }[] = [
    { input: "", pattern: "Invalid repository name" },
    { input: "../etc", pattern: "path traversal" },
    { input: ".", pattern: "reserved" },
    { input: "foo/../bar", pattern: "path traversal" },
    { input: "foo\\bar", pattern: "path traversal" },
  ];

  for (const { input, pattern } of errorCases) {
    await t.step(`rejects "${input}"`, () => {
      assertThrows(() => validateSafeName(input), Error, pattern);
    });
  }
});

Deno.test("detectConflicts finds conflicts across three workspaces", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    repositories: [
      { name: "shared", url: "u", workspace: undefined },
      { name: "shared", url: "u2", workspace: "child-a" },
      { name: "shared", url: "u3", workspace: "child-b" },
    ],
  };
  const conflicts = detectConflicts(resolved);
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0].repoName, "shared");
  assertEquals(conflicts[0].claimedBy.length, 3);
});

Deno.test("detectConflicts finds multiple distinct conflicts", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    repositories: [
      { name: "a", url: "u", workspace: undefined },
      { name: "a", url: "u2", workspace: "child" },
      { name: "b", url: "u3", workspace: undefined },
      { name: "b", url: "u4", workspace: "child" },
    ],
  };
  const conflicts = detectConflicts(resolved);
  assertEquals(conflicts.length, 2);
});

Deno.test("listWorkspaces returns empty for empty repositories", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    repositories: [],
  };
  assertEquals(listWorkspaces(resolved).length, 0);
});

Deno.test("listWorkspaces groups repos by workspace name", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    repositories: [
      { name: "a", url: "u", workspace: undefined },
      { name: "b", url: "u2", workspace: "child-x" },
      { name: "c", url: "u3", workspace: "child-x" },
      { name: "d", url: "u4", workspace: "child-y" },
    ],
  };
  const ws = listWorkspaces(resolved);
  assertEquals(ws.length, 3);
  assertEquals(ws[0], { name: "(root)", repos: 1, child: false });
  assertEquals(ws[1], { name: "child-x", repos: 2, child: true });
  assertEquals(ws[2], { name: "child-y", repos: 1, child: true });
});

// --- findManifestWalkingUp tests ---

Deno.test("findManifestWalkingUp finds manifest in current directory", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(manifestPath, "{}\n");
    assertEquals(await findManifestWalkingUp(tempDir), manifestPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findManifestWalkingUp finds manifest in parent directory", async () => {
  const parent = await Deno.makeTempDir();
  const child = join(parent, "child", "nested");
  await Deno.mkdir(child, { recursive: true });
  try {
    const manifestPath = join(parent, "workspace.json");
    await Deno.writeTextFile(manifestPath, "{}\n");
    assertEquals(await findManifestWalkingUp(child), manifestPath);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("findManifestWalkingUp returns undefined when no manifest exists", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(await findManifestWalkingUp(tempDir), undefined);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findDefaultManifestPath uses walk-up discovery", async () => {
  const parent = await Deno.makeTempDir();
  const child = join(parent, "subdir");
  await Deno.mkdir(child, { recursive: true });
  try {
    // Manifest in parent, calling from child — walk-up should find it
    const manifestPath = join(parent, "workspace.json");
    await Deno.writeTextFile(manifestPath, "{}\n");
    assertEquals(await findDefaultManifestPath(child), manifestPath);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
