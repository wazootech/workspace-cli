import { assertEquals, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { manifestPaths, validateManifest } from "../src/manifest.ts";
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
  const paths = manifestPaths(manifest, join("ws", "repos.json"));
  assertEquals(paths.root, dirname(join("ws", "repos.json")));
  assertEquals(paths.repositoriesDirectory, join("ws", "repos"));
  assertEquals(paths.worktreesDirectory, join("ws", "worktrees"));
  assertEquals(paths.vaultDirectory, join("ws", "secrets"));
});

Deno.test("manifestPaths honors workspaceRoot override", () => {
  const manifest: WorkspaceManifest = { workspaceRoot: "..", repositories: [] };
  const paths = manifestPaths(manifest, join("ws", "repos.json"));
  assertEquals(paths.root, "..");
});

Deno.test("manifestPaths honors absolute workspaceRoot", () => {
  const manifest: WorkspaceManifest = {
    workspaceRoot: "C:\\wazoo",
    repositories: [],
  };
  const paths = manifestPaths(manifest, "C:\\ws\\repos.json");
  assertEquals(paths.root, "C:\\wazoo");
});
