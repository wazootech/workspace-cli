import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  detectConflicts,
  findDefaultManifestPath,
  listWorkspaces,
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
  assertThrows(() => validateManifest(manifest), Error, "name and url");
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
  assertThrows(
    () => validateManifest(manifest),
    Error,
    "require name and url, or name and manifest",
  );
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

Deno.test("validateManifest accepts schema version 3", () => {
  validateManifest({ schemaVersion: 3, repositories: [] });
});

Deno.test("validateManifest rejects schema version 4", () => {
  const manifest: WorkspaceManifest = { schemaVersion: 4, repositories: [] };
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
  assertEquals(paths.vaultDirectory, join(dirname(manifestFile), "secrets"));
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

// --- Schema v2: recursive sub-workspace tests ---

Deno.test("validateManifest accepts valid workspaces array", () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "https://example.com/a.git" }],
    workspaces: [
      { name: "worlds", path: "../worlds/workspace.json" },
    ],
  };
  validateManifest(manifest);
});

Deno.test("validateManifest rejects duplicate workspace names", () => {
  const manifest: WorkspaceManifest = {
    repositories: [{ name: "a", url: "https://example.com/a.git" }],
    workspaces: [
      { name: "x", path: "../x.json" },
      { name: "x", path: "../x2.json" },
    ],
  };
  assertThrows(
    () => validateManifest(manifest),
    Error,
    "Duplicate workspace name",
  );
});

Deno.test("validateManifest rejects workspace entry without name", () => {
  const manifest = {
    repositories: [],
    workspaces: [{ path: "../child.json" }],
  } as unknown as WorkspaceManifest;
  assertThrows(
    () => validateManifest(manifest),
    Error,
    "Workspace entries require name and path",
  );
});

Deno.test("validateManifest rejects workspace entry with traversal name", () => {
  const manifest: WorkspaceManifest = {
    repositories: [],
    workspaces: [{ name: "../bad", path: "../child.json" }],
  };
  assertThrows(
    () => validateManifest(manifest),
    Error,
    "invalid characters or path traversal",
  );
});

Deno.test("resolveWorkspaceTree flattens parent and child repos", async () => {
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
        ],
        workspaces: [{ name: "child-ws", path: "child/workspace.json" }],
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
        ],
        workspaces: [{ name: "child-ws", path: "child/workspace.json" }],
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
        repositories: [],
        workspaces: [{ name: "child-ws", path: "child/workspace.json" }],
      }),
    );
    await Deno.writeTextFile(
      join(tempDir, "child", "workspace.json"),
      JSON.stringify({
        repositories: [
          { name: "mid-repo", url: "https://example.com/mid.git" },
        ],
        workspaces: [{ name: "nested-ws", path: "nested/workspace.json" }],
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
        repositories: [],
        workspaces: [{ name: "a", path: "a/workspace.json" }],
      }),
    );
    await Deno.writeTextFile(
      join(tempDir, "a", "workspace.json"),
      JSON.stringify({
        repositories: [],
        workspaces: [{ name: "b", path: "../b/workspace.json" }],
      }),
    );
    await Deno.writeTextFile(
      join(tempDir, "b", "workspace.json"),
      JSON.stringify({
        repositories: [],
        workspaces: [{ name: "back-to-root", path: "../workspace.json" }],
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
        repositories: [],
        workspaces: [
          { name: "dup", path: "one/workspace.json" },
          { name: "two", path: "two/workspace.json" },
        ],
      }),
    );
    await Deno.writeTextFile(
      join(tempDir, "one", "workspace.json"),
      JSON.stringify({
        repositories: [],
        workspaces: [{ name: "dup", path: "inner/workspace.json" }],
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
        repositories: [],
        workspaces: [{ name: "missing", path: "nope/workspace.json" }],
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

Deno.test("resolveWorkspaceTree merges inline references and legacy workspaces", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const parentManifestPath = join(tempDir, "workspace.json");
    for (const name of ["inline-ws", "legacy-ws"]) {
      await Deno.mkdir(join(tempDir, name), { recursive: true });
      await Deno.writeTextFile(
        join(tempDir, name, "workspace.json"),
        JSON.stringify({
          repositories: [
            { name: `${name}-repo`, url: `https://example.com/${name}.git` },
          ],
        }),
      );
    }

    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        schemaVersion: 3,
        repositories: [
          { name: "inline-ws", manifest: "inline-ws/workspace.json" },
        ],
        workspaces: [
          { name: "legacy-ws", path: "legacy-ws/workspace.json" },
        ],
      }),
    );

    const { loadManifest } = await import("../src/manifest.ts");
    const manifest = await loadManifest(parentManifestPath);
    const resolved = await resolveWorkspaceTree(manifest, parentManifestPath);

    assertEquals(resolved.children.size, 2);
    assertEquals(resolved.children.has("inline-ws"), true);
    assertEquals(resolved.children.has("legacy-ws"), true);
    assertEquals(resolved.repositories.length, 2);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorkspaceTree rejects duplicate workspace names across forms", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const parentManifestPath = join(tempDir, "workspace.json");
    await Deno.mkdir(join(tempDir, "dupe"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "dupe", "workspace.json"),
      JSON.stringify({
        repositories: [],
      }),
    );
    await Deno.writeTextFile(
      parentManifestPath,
      JSON.stringify({
        repositories: [
          { name: "dupe", manifest: "dupe/workspace.json" },
        ],
        workspaces: [
          { name: "dupe", path: "dupe/workspace.json" },
        ],
      }),
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
