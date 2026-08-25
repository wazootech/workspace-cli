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
} from "../src/manifest.ts";
import type { RepositoryEntry, WorkspaceManifest } from "../src/types.ts";

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
  } as WorkspaceManifest;
  assertThrows(() => validateManifest(manifest), Error, "requires a url");
});

Deno.test("validateManifest rejects a newer schema version", () => {
  const manifest: WorkspaceManifest = { schemaVersion: 99, repositories: [] };
  assertThrows(() => validateManifest(manifest), Error, "newer than supported");
});

// --- Schema v3: unified sub-workspace references in repositories ---

Deno.test("validateManifest accepts an inline sub-workspace reference", () => {
  const manifest: WorkspaceManifest = {
    schemaVersion: 3,
    repositories: [
      { name: "a", url: "https://example.com/a.git" },
      { name: "worlds", manifest: "../worlds/workspace.json" },
    ],
  };
  validateManifest(manifest);
});

Deno.test("validateManifest accepts a reference with an optional url", () => {
  const manifest: WorkspaceManifest = {
    repositories: [
      {
        name: "worlds",
        url: "https://example.com/worlds.git",
        manifest: "../worlds/workspace.json",
      },
    ],
  };
  validateManifest(manifest);
});

Deno.test("validateManifest rejects a reference with leaf-only fields", () => {
  const refs = [
    { name: "worlds", manifest: "../w.json", path: "." },
    { name: "worlds", manifest: "../w.json", groups: ["beta"] },
    { name: "worlds", manifest: "../w.json", localFiles: [".env"] },
  ] as unknown as RepositoryEntry[];
  for (const ref of refs) {
    assertThrows(
      () => validateManifest({ repositories: [ref] }),
      Error,
      "cannot combine",
    );
  }
});

Deno.test("validateManifest rejects an entry with neither url nor manifest", () => {
  const manifest = {
    repositories: [{ name: "a" }],
  } as WorkspaceManifest;
  assertThrows(() => validateManifest(manifest), Error, "requires a url");
});

Deno.test("validateManifest treats an empty manifest path as missing", () => {
  const manifest = {
    repositories: [{ name: "a", manifest: "" }],
  } as unknown as WorkspaceManifest;
  assertThrows(
    () => validateManifest(manifest),
    Error,
    "require name and url, or name and manifest",
  );
});

Deno.test("validateManifest rejects an empty url on a reference", () => {
  const manifest = {
    repositories: [{ name: "a", url: "", manifest: "../x.json" }],
  } as unknown as WorkspaceManifest;
  assertThrows(
    () => validateManifest(manifest),
    Error,
    "require name and url, or name and manifest",
  );
});

// --- JSONC and YAML manifests ---

Deno.test("loadManifest parses jsonc manifests with comments", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "workspace.jsonc");
    await Deno.writeTextFile(
      manifestPath,
      `{
        // Cluster manifest for the umbra wikis.
        "schemaVersion": 3,
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

Deno.test("loadManifest parses yaml manifests", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.yaml");
    await Deno.writeTextFile(
      manifestPath,
      `schemaVersion: 3
repositories:
  - name: a
    url: https://example.com/a.git
`,
    );

    const manifest = await loadManifest(manifestPath);
    assertEquals(manifest.repositories.length, 1);
    assertEquals(manifest.repositories[0].url, "https://example.com/a.git");
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

Deno.test("loadManifest rejects yaml documents without a repositories array", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.yaml");
    await Deno.writeTextFile(manifestPath, "repositories: 3\n");
    await assertRejects(
      () => loadManifest(manifestPath),
      Error,
      "must be an object with a repositories array",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("findDefaultManifestPath discovers jsonc and yaml manifests", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // Discovery is name-first (workspace > wspace > repos), then extension
    // (.json > .jsonc > .yaml > .yml).
    const jsoncPath = join(tempDir, "wspace.jsonc");
    await Deno.writeTextFile(jsoncPath, "{}\n");
    assertEquals(await findDefaultManifestPath(tempDir), jsoncPath);

    const yamlPath = join(tempDir, "workspace.yaml");
    await Deno.writeTextFile(yamlPath, "repositories: []\n");
    assertEquals(await findDefaultManifestPath(tempDir), yamlPath);

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

Deno.test("validateManifest rejects duplicate names across kinds", () => {
  const manifest = {
    repositories: [
      { name: "a", url: "https://example.com/a.git" },
      { name: "a", manifest: "../a-ws/workspace.json" },
    ],
  } as unknown as WorkspaceManifest;
  assertThrows(() => validateManifest(manifest), Error, "Duplicate");
});

Deno.test("validateManifest rejects an inline reference without a name", () => {
  const manifest = {
    repositories: [{ manifest: "../child.json" }],
  } as unknown as WorkspaceManifest;
  assertThrows(
    () => validateManifest(manifest),
    Error,
    "Repository entries require",
  );
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

Deno.test("findDefaultManifestPath respects fallback order workspace.json -> wspace.json -> repos.json", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // When no manifest exists, defaults to workspace.json
    assertEquals(
      await findDefaultManifestPath(tempDir),
      join(tempDir, "workspace.json"),
    );

    // If repos.json exists, resolves repos.json
    const reposPath = join(tempDir, "repos.json");
    await Deno.writeTextFile(reposPath, "{}");
    assertEquals(await findDefaultManifestPath(tempDir), reposPath);

    // If wspace.json exists, takes priority over repos.json
    const wspacePath = join(tempDir, "wspace.json");
    await Deno.writeTextFile(wspacePath, "{}");
    assertEquals(await findDefaultManifestPath(tempDir), wspacePath);

    // If workspace.json exists, takes top priority
    const workspacePath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(workspacePath, "{}");
    assertEquals(await findDefaultManifestPath(tempDir), workspacePath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// --- Schema v4: owner shorthand, evictions, and auto-detection ---

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
    assertEquals(manifest.repositories[0].autoCompose, true);
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
    assertEquals(manifest.repositories[0].autoCompose, undefined);
    assertEquals(
      manifest.repositories[0].url,
      "https://gitlab.com/other/elsewhere.git",
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

Deno.test("resolveWorkspaceTree flattens parent and child repos via inline reference", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const parentManifestPath = join(tempDir, "workspace.json");
    const childManifestPath = join(tempDir, "child", "workspace.json");
    await Deno.mkdir(join(tempDir, "child"), { recursive: true });

    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          { name: "parent-repo", url: "https://example.com/parent.git" },
          { name: "child-ws", manifest: "child/workspace.json" },
        ],
      }),
    );
    await Deno.writeTextFile(
      childManifestPath,
      JSON.stringify({
        repositories: [
          { name: "child-repo", url: "https://example.com/child.git" },
        ],
      }),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(parentManifestPath);
    const resolved = await resolveWorkspaceTree(manifest, parentManifestPath);

    assertEquals(resolved.repositories.length, 2);
    assertEquals(resolved.repositories[0].name, "parent-repo");
    assertEquals(resolved.repositories[0].workspace, undefined);
    assertEquals(resolved.repositories[1].name, "child-repo");
    assertEquals(resolved.repositories[1].workspace, "child-ws");
    assertEquals(resolved.children.size, 1);
    assertEquals(resolved.children.has("child-ws"), true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorkspaceTree resolves child repos against the child workspace root", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const parentManifestPath = join(tempDir, "workspace.json");
    const childManifestPath = join(tempDir, "child", "workspace.json");
    await Deno.mkdir(join(tempDir, "child"), { recursive: true });

    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          { name: "parent-repo", url: "https://example.com/parent.git" },
          { name: "child-ws", manifest: "child/workspace.json" },
        ],
      }),
    );
    await Deno.writeTextFile(
      childManifestPath,
      JSON.stringify({
        repositories: [
          // Relative to the CHILD workspace root (tempDir/child), not the parent's.
          {
            name: "child-repo",
            url: "https://example.com/child.git",
            path: "repos/child-repo",
          },
          {
            name: "child-root",
            url: "https://example.com/root.git",
            path: ".",
          },
        ],
      }),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(parentManifestPath);
    const resolved = await resolveWorkspaceTree(manifest, parentManifestPath);

    assertEquals(resolved.repositories.length, 3);
    const childRepo = resolved.repositories.find((r) =>
      r.name === "child-repo"
    );
    assertEquals(childRepo?.workspace, "child-ws");
    assertEquals(
      childRepo?.resolvedPath,
      join(tempDir, "child", "repos", "child-repo"),
    );
    const childRoot = resolved.repositories.find((r) =>
      r.name === "child-root"
    );
    assertEquals(childRoot?.resolvedPath, join(tempDir, "child"));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorkspaceTree recurses into nested sub-workspaces", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const parentManifestPath = join(tempDir, "workspace.json");
    await Deno.mkdir(join(tempDir, "child", "nested"), { recursive: true });

    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          { name: "child-ws", manifest: "child/workspace.json" },
        ],
      }),
    );
    await Deno.writeTextFile(
      join(tempDir, "child", "workspace.json"),
      JSON.stringify({
        repositories: [
          { name: "mid-repo", url: "https://example.com/mid.git" },
          { name: "nested-ws", manifest: "nested/workspace.json" },
        ],
      }),
    );
    await Deno.writeTextFile(
      join(tempDir, "child", "nested", "workspace.json"),
      JSON.stringify({
        repositories: [
          {
            name: "deep-repo",
            url: "https://example.com/deep.git",
            path: "deep-repo",
          },
        ],
      }),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(parentManifestPath);
    const resolved = await resolveWorkspaceTree(manifest, parentManifestPath);

    assertEquals(resolved.children.size, 2);
    assertEquals(resolved.children.has("child-ws"), true);
    assertEquals(resolved.children.has("nested-ws"), true);

    const mid = resolved.repositories.find((r) => r.name === "mid-repo");
    assertEquals(mid?.workspace, "child-ws");
    assertEquals(
      mid?.resolvedPath,
      join(tempDir, "child", "repos", "mid-repo"),
    );

    const deep = resolved.repositories.find((r) => r.name === "deep-repo");
    assertEquals(deep?.workspace, "nested-ws");
    assertEquals(
      deep?.resolvedPath,
      join(tempDir, "child", "nested", "deep-repo"),
    );

    const listing = listWorkspaces(resolved);
    assertEquals(listing.length, 2);
    assertEquals(
      listing.find((ws) => ws.name === "nested-ws"),
      { name: "nested-ws", repos: 1, child: true },
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorkspaceTree throws on circular manifest references", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tempDir, "a"), { recursive: true });
    await Deno.mkdir(join(tempDir, "b"), { recursive: true });

    await Deno.writeTextFile(
      join(tempDir, "workspace.json"),
      JSON.stringify({
        repositories: [{ name: "a", manifest: "a/workspace.json" }],
      }),
    );
    await Deno.writeTextFile(
      join(tempDir, "a", "workspace.json"),
      JSON.stringify({
        repositories: [{ name: "b", manifest: "../b/workspace.json" }],
      }),
    );
    await Deno.writeTextFile(
      join(tempDir, "b", "workspace.json"),
      JSON.stringify({
        repositories: [{ name: "back-to-root", manifest: "../workspace.json" }],
      }),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(join(tempDir, "workspace.json"));
    await assertRejects(
      () => resolveWorkspaceTree(manifest, join(tempDir, "workspace.json")),
      Error,
      "Circular sub-workspace reference",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorkspaceTree throws on duplicate workspace names across levels", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tempDir, "one", "inner"), { recursive: true });
    await Deno.mkdir(join(tempDir, "two"), { recursive: true });

    await Deno.writeTextFile(
      join(tempDir, "workspace.json"),
      JSON.stringify({
        repositories: [
          { name: "dup", manifest: "one/workspace.json" },
          { name: "two", manifest: "two/workspace.json" },
        ],
      }),
    );
    await Deno.writeTextFile(
      join(tempDir, "one", "workspace.json"),
      JSON.stringify({
        repositories: [{ name: "dup", manifest: "inner/workspace.json" }],
      }),
    );
    await Deno.writeTextFile(
      join(tempDir, "one", "inner", "workspace.json"),
      JSON.stringify({ repositories: [] }),
    );
    await Deno.writeTextFile(
      join(tempDir, "two", "workspace.json"),
      JSON.stringify({ repositories: [] }),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(join(tempDir, "workspace.json"));
    await assertRejects(
      () => resolveWorkspaceTree(manifest, join(tempDir, "workspace.json")),
      Error,
      "Duplicate workspace name",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorkspaceTree throws when child manifest missing", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const parentManifestPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [{ name: "missing", manifest: "nope/workspace.json" }],
      }),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(parentManifestPath);
    await assertRejects(
      () => resolveWorkspaceTree(manifest, parentManifestPath),
      Error,
      'Sub-workspace "missing" manifest not found',
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// --- Schema v3: inline sub-workspace references in resolveWorkspaceTree ---

Deno.test("resolveWorkspaceTree flattens repos declared through inline references", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const parentManifestPath = join(tempDir, "workspace.json");
    const childManifestPath = join(tempDir, "child", "workspace.json");
    await Deno.mkdir(join(tempDir, "child"), { recursive: true });

    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        schemaVersion: 3,
        repositories: [
          { name: "parent-repo", url: "https://example.com/parent.git" },
          { name: "child-ws", manifest: "child/workspace.json" },
        ],
      }),
    );
    await Deno.writeTextFile(
      childManifestPath,
      JSON.stringify({
        repositoriesDirectory: ".",
        repositories: [
          { name: "child-repo", url: "https://example.com/child.git" },
        ],
      }),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(parentManifestPath);
    const resolved = await resolveWorkspaceTree(manifest, parentManifestPath);

    assertEquals(resolved.repositories.length, 2);
    assertEquals(resolved.repositories[0].name, "parent-repo");
    assertEquals(resolved.repositories[0].workspace, undefined);
    assertEquals(resolved.repositories[1].name, "child-repo");
    assertEquals(resolved.repositories[1].workspace, "child-ws");
    assertEquals(resolved.children.size, 1);
    assertEquals(resolved.children.has("child-ws"), true);
    // Child repo resolves against the CHILD workspace root.
    const childRepo = resolved.repositories[1];
    assertEquals(childRepo.resolvedPath, join(tempDir, "child", "child-repo"));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// --- Schema v4: auto-composition of bare-string entries ---

Deno.test("resolveWorkspaceTree auto-composes a detected sub-workspace", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // Container checkout with its own manifest at <repos>/container/repos.json
    const containerDir = join(tempDir, "repos", "container");
    await Deno.mkdir(containerDir, { recursive: true });
    await Deno.writeTextFile(
      join(containerDir, "repos.json"),
      JSON.stringify({
        repositoriesDirectory: ".",
        repositories: [
          { name: "inner", url: "https://example.com/inner.git" },
        ],
      }),
    );

    const parentManifestPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [{
          name: "container",
          url: "https://github.com/wazootech/container.git",
          autoCompose: true,
        }],
      } as unknown as WorkspaceManifest),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(parentManifestPath);
    const resolved = await resolveWorkspaceTree(manifest, parentManifestPath);

    assertEquals(resolved.children.size, 1);
    assertEquals(resolved.children.has("container"), true);
    assertEquals(resolved.repositories.length, 2);
    // The container itself stays a root-attributed repository row...
    assertEquals(resolved.repositories[0].name, "container");
    assertEquals(resolved.repositories[0].workspace, undefined);
    // ...and the discovered child composes under the container's name.
    assertEquals(resolved.repositories[1].name, "inner");
    assertEquals(resolved.repositories[1].workspace, "container");
    assertEquals(
      resolved.repositories[1].resolvedPath,
      join(containerDir, "inner"),
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorkspaceTree leaves object entries alone even when a manifest exists", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const containerDir = join(tempDir, "repos", "explicit");
    await Deno.mkdir(containerDir, { recursive: true });
    await Deno.writeTextFile(
      join(containerDir, "repos.json"),
      JSON.stringify({ repositories: [] }),
    );

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

    assertEquals(resolved.children.size, 0);
    assertEquals(resolved.repositories.length, 1);
    assertEquals(resolved.repositories[0].name, "explicit");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorkspaceTree degrades silently when detection revisits the root manifest", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // Entry checks out at the workspace root itself (path "."), where the
    // root manifest lives. Detection finds it; the visited set suppresses
    // the cycle and the entry stays a plain leaf row.
    const parentManifestPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          {
            name: "self",
            url: "https://github.com/wazootech/self.git",
            path: ".",
            autoCompose: true,
          },
        ],
      } as unknown as WorkspaceManifest),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(parentManifestPath);
    const resolved = await resolveWorkspaceTree(manifest, parentManifestPath);

    assertEquals(resolved.children.size, 0);
    assertEquals(resolved.repositories.length, 1);
    assertEquals(resolved.repositories[0].name, "self");
    assertEquals(resolved.repositories[0].workspace, undefined);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// --- Optional url on references (bootstrap cloning) ---

Deno.test("resolveWorkspaceTree exposes references with checkout paths", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const parentManifestPath = join(tempDir, "workspace.json");
    const childDir = join(tempDir, "umbrella");
    await Deno.mkdir(childDir, { recursive: true });
    await Deno.writeTextFile(
      join(childDir, "workspace.json"),
      JSON.stringify({ repositoriesDirectory: ".", repositories: [] }),
    );
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          {
            name: "umbra-suite",
            url: "https://example.com/umbra.git",
            manifest: "umbrella/workspace.json",
          },
        ],
      }),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(parentManifestPath);
    const resolved = await resolveWorkspaceTree(manifest, parentManifestPath);

    assertEquals(resolved.repositories.length, 0);
    assertEquals(resolved.references.length, 1);
    const ref = resolved.references[0];
    assertEquals(ref.name, "umbra-suite");
    assertEquals(ref.url, "https://example.com/umbra.git");
    assertEquals(ref.resolvedPath, join(tempDir, "repos", "umbra-suite"));
    // References are attributed to their declaring workspace.
    assertEquals(ref.workspace, undefined);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("detectConflicts flags reference names claimed elsewhere", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    children: new Map(),
    references: [
      { name: "shared", url: "u", manifest: "../x.json", workspace: undefined },
    ],
    repositories: [
      { name: "shared", url: "u2", workspace: "child-a" },
    ],
  };
  const conflicts = detectConflicts(resolved);
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0].claimedBy, ["(root)", "child-a"]);
});

Deno.test("detectConflicts finds duplicate repo names across workspaces", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    children: new Map(),
    references: [],
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
    children: new Map(),
    references: [],
    repositories: [
      { name: "a", url: "u", workspace: undefined },
      { name: "b", url: "u2", workspace: "child" },
    ],
  };
  assertEquals(detectConflicts(resolved).length, 0);
});

Deno.test("listWorkspaces returns root and children with repo counts", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    children: new Map([
      ["child-ws", { repositories: [] } as WorkspaceManifest],
    ]),
    references: [],
    repositories: [
      { name: "a", url: "u", workspace: undefined },
      { name: "b", url: "u2", workspace: undefined },
      { name: "c", url: "u3", workspace: "child-ws" },
    ],
  };
  const ws = listWorkspaces(resolved);
  assertEquals(ws.length, 2);
  assertEquals(ws[0], { name: "(root)", repos: 2, child: false });
  assertEquals(ws[1], { name: "child-ws", repos: 1, child: true });
});

Deno.test("listWorkspaces omits root when all repos are in children", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    children: new Map([
      ["child", { repositories: [] } as WorkspaceManifest],
    ]),
    references: [],
    repositories: [
      { name: "a", url: "u", workspace: "child" },
    ],
  };
  const ws = listWorkspaces(resolved);
  assertEquals(ws.length, 1);
  assertEquals(ws[0].name, "child");
});
