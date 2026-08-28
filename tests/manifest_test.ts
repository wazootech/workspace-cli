import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  detectConflicts,
  findDefaultManifestPath,
  listWorkspaces,
  loadManifest,
  manifestPaths,
  resolveWorkspaceTree,
  validateManifest,
} from "@/manifest.ts";
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

// --- Manifest format tests ---

Deno.test("loadManifest parses jsonc manifests with comments", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.jsonc");
    await Deno.writeTextFile(
      manifestPath,
      `{
        // Cluster manifest for the umbra wikis.
        "schemaVersion": 4,
        "repositories": [
          { "name": "a", "url": "https://example.com/a.git", }, // trailing comma
        ],
      }`,
    );

    const manifest = await loadManifest(manifestPath);
    assertEquals(manifest.repositories.length, 1);
    assertEquals(manifest.repositories[0].name, "a");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
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

Deno.test("findDefaultManifestPath discovers json and jsonc manifests", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // Discovery is name-first (workspace), then extension (.json > .jsonc).
    const jsoncPath = join(tempDir, "workspace.jsonc");
    await Deno.writeTextFile(jsoncPath, "{}\n");
    assertEquals(await findDefaultManifestPath(tempDir), jsoncPath);

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

// --- Schema v4: owner shorthand, evictions ---

Deno.test("loadManifest expands bare-string entries against owner", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.json");
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 4,
        owner: "ethanthatonekid",
        repositories: ["etok.me", "memsdk"],
      }),
    );

    const manifest = await loadManifest(manifestPath);
    assertEquals(manifest.owner, "ethanthatonekid");
    assertEquals(manifest.repositories.length, 2);
    assertEquals(manifest.repositories[0].name, "etok.me");
    assertEquals(
      manifest.repositories[0].url,
      "https://github.com/ethanthatonekid/etok.me.git",
    );
    assertEquals(
      manifest.repositories[1].url,
      "https://github.com/ethanthatonekid/memsdk.git",
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
      JSON.stringify({ repositories: ["etok.me"] }),
    );
    await assertRejects(
      () => loadManifest(manifestPath),
      Error,
      'requires "owner"',
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
      "https://github.com/wazootech/memsdk.git",
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
        repositories: ["wazootech/memsdk", "etok.me"],
      }),
    );

    const manifest = await loadManifest(manifestPath);
    assertEquals(
      manifest.repositories[0].url,
      "https://github.com/wazootech/memsdk.git",
    );
    assertEquals(
      manifest.repositories[1].url,
      "https://github.com/ethanthatonekid/etok.me.git",
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
      'exactly "owner/name"',
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
      "https://gitlab.com/wazootech/memsdk.git",
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

Deno.test("loadManifest rejects entries carrying removed fields", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.json");
    for (
      const entry of [
        { name: "a", url: "u", path: "." },
        { name: "a", url: "u", groups: ["beta"] },
        { name: "a", url: "u", localFiles: [".env.qa"] },
        { name: "a", url: "u", manifest: "../child/repos.json" },
      ]
    ) {
      await Deno.writeTextFile(
        manifestPath,
        JSON.stringify({ repositories: [entry] }),
      );
      await assertRejects(
        () => loadManifest(manifestPath),
        Error,
        "not supported in schema v4",
      );
    }
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
