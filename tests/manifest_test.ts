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
  } as WorkspaceManifest;
  assertThrows(() => validateManifest(manifest), Error, "name and url");
});

Deno.test("validateManifest rejects a newer schema version", () => {
  const manifest: WorkspaceManifest = { schemaVersion: 99, repositories: [] };
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
