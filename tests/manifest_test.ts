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
