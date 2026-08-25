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
import type { WorkspaceManifest } from "../src/types.ts";

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

// --- JSONC and YAML manifests ---

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

Deno.test("loadManifest parses yaml manifests", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifestPath = join(tempDir, "repos.yaml");
    await Deno.writeTextFile(
      manifestPath,
      `schemaVersion: 4
owner: acme
repositories:
  - shared-reference
`,
    );

    const manifest = await loadManifest(manifestPath);
    assertEquals(manifest.repositories.length, 1);
    assertEquals(
      manifest.repositories[0].url,
      "https://github.com/acme/shared-reference.git",
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
    assertEquals(manifest.repositories[0].autoCompose, true);
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
    assertEquals(manifest.repositories[0].autoCompose, true);
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

// --- Schema v4: auto-composition of bare-string entries ---

/** Writes a container checkout containing its own manifest. */
async function seedContainer(
  dir: string,
  options: { repositoriesDirectory?: string; repositories: unknown[] },
): Promise<string> {
  const containerDir = join(dir, "repos", "container");
  await Deno.mkdir(containerDir, { recursive: true });
  await Deno.writeTextFile(
    join(containerDir, "repos.json"),
    JSON.stringify(options),
  );
  return containerDir;
}

Deno.test("resolveWorkspaceTree auto-composes a detected sub-workspace", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const containerDir = await seedContainer(tempDir, {
      repositoriesDirectory: ".",
      repositories: [{ name: "inner", url: "https://example.com/inner.git" }],
    });

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

Deno.test("resolveWorkspaceTree resolves detected child repos against the child root", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await seedContainer(tempDir, {
      repositories: [
        { name: "pinned", url: "https://example.com/pinned.git" },
      ],
    });

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

    // Without repositoriesDirectory override the child repo lands under the
    // child's own conventional repos/ directory.
    const pinned = resolved.repositories.find((r) => r.name === "pinned");
    assertEquals(pinned?.workspace, "container");
    assertEquals(
      pinned?.resolvedPath,
      join(tempDir, "repos", "container", "repos", "pinned"),
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorkspaceTree recurses into nested detected sub-workspaces", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // container detects inner (string), inner's own checkout would host a
    // further manifest only after ITS clone; model that by pre-placing the
    // grandchild manifest inside inner's future checkout directory.
    const containerDir = join(tempDir, "repos", "container");
    const innerDir = join(containerDir, "repos", "inner");
    await Deno.mkdir(innerDir, { recursive: true });
    await Deno.writeTextFile(
      join(containerDir, "repos.json"),
      JSON.stringify({ owner: "acme", repositories: ["inner"] }),
    );
    await Deno.writeTextFile(
      join(innerDir, "repos.json"),
      JSON.stringify({
        repositories: [
          { name: "deep", url: "https://example.com/deep.git" },
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

    assertEquals(resolved.children.size, 2);
    assertEquals(resolved.children.has("container"), true);
    assertEquals(resolved.children.has("inner"), true);

    const deep = resolved.repositories.find((r) => r.name === "deep");
    assertEquals(deep?.workspace, "inner");
    assertEquals(deep?.resolvedPath, join(innerDir, "repos", "deep"));

    const listing = listWorkspaces(resolved);
    assertEquals(listing.length, 3);
    assertEquals(
      listing.find((ws) => ws.name === "inner"),
      { name: "inner", repos: 1, child: true },
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorkspaceTree throws on duplicate detected workspace names across levels", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    for (const container of ["one", "two"]) {
      const containerDir = join(tempDir, "repos", container);
      await Deno.mkdir(join(containerDir, "repos", "dup"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(containerDir, "repos.json"),
        JSON.stringify({ owner: "acme", repositories: ["dup"] }),
      );
      await Deno.writeTextFile(
        join(containerDir, "repos", "dup", "repos.json"),
        JSON.stringify({ repositories: [] }),
      );
    }

    const parentManifestPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          "one",
          "two",
        ].map((name) => ({
          name,
          url: `https://github.com/wazootech/${name}.git`,
          autoCompose: true,
        })),
      } as unknown as WorkspaceManifest),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(parentManifestPath);
    await assertRejects(
      () => resolveWorkspaceTree(manifest, parentManifestPath),
      Error,
      "Duplicate workspace name",
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
    // A repository checked out at the workspace root itself hosts the root
    // manifest. Detection finds it; the visited set suppresses the cycle and
    // the entry stays a plain leaf row.
    const parentManifestPath = join(tempDir, "workspace.json");
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          {
            name: "self",
            url: "https://github.com/wazootech/self.git",
            resolvedPath: tempDir,
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

Deno.test("detectConflicts finds duplicate repo names across workspaces", () => {
  const resolved = {
    root: { repositories: [] } as WorkspaceManifest,
    children: new Map(),
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
    repositories: [
      { name: "a", url: "u", workspace: "child" },
    ],
  };
  const ws = listWorkspaces(resolved);
  assertEquals(ws.length, 1);
  assertEquals(ws[0].name, "child");
});
