import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolvePaths } from "@/commands/path.ts";
import type { ManifestPaths } from "@/manifest.ts";
import type { RepositoryEntry } from "@/types.ts";

const root = Deno.build.os === "windows" ? "C:\\workspace" : "/workspace";
const paths: ManifestPaths = {
  root,
  repositoriesDirectory: join(root, "repos"),
  worktreesDirectory: join(root, "worktrees"),
  secretsDirectory: join(root, "secrets"),
};

const repos: RepositoryEntry[] = [
  { name: "api", url: "https://github.com/acme/api" },
  { name: "web-client", url: "https://github.com/acme/web-client" },
  { name: "docs", url: "https://github.com/acme/docs" },
  { name: "docs.wazoo.dev", url: "https://github.com/acme/docs.wazoo.dev" },
  {
    name: "sub-api",
    url: "https://github.com/acme/sub-api",
    workspace: "sub",
  },
];

Deno.test("resolvePaths", async (t) => {
  await t.step("exact match returns single result", () => {
    const results = resolvePaths("api", repos, paths, {});
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "api");
    assertEquals(results[0].path, join(paths.repositoriesDirectory, "api"));
  });

  await t.step("exact match is case-insensitive", () => {
    const results = resolvePaths("API", repos, paths, {});
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "api");
  });

  await t.step("substring match returns multiple results", () => {
    const results = resolvePaths("doc", repos, paths, {});
    assertEquals(results.length, 2);
    assertEquals(
      results.map((r) => r.name).sort(),
      ["docs", "docs.wazoo.dev"],
    );
  });

  await t.step("no match returns empty array", () => {
    const results = resolvePaths("nonexistent", repos, paths, {});
    assertEquals(results.length, 0);
  });

  await t.step("accepts dotted repo name (.github style)", () => {
    const dottedRepos: RepositoryEntry[] = [
      { name: ".github", url: "https://github.com/acme/.github" },
    ];
    const results = resolvePaths(".github", dottedRepos, paths, {});
    assertEquals(results.length, 1);
    assertEquals(results[0].name, ".github");
    assertEquals(results[0].path, join(paths.repositoriesDirectory, ".github"));
  });

  await t.step("--feature resolves worktree path", () => {
    const results = resolvePaths("api", repos, paths, {
      feature: "my-feature",
    });
    assertEquals(results.length, 1);
    assertEquals(
      results[0].path,
      join(paths.worktreesDirectory, "api", "my-feature"),
    );
  });

  await t.step("--workspace scopes to matching repos", () => {
    const scopedRepos = repos.filter((r) => r.workspace === "sub");
    const results = resolvePaths("sub-api", scopedRepos, paths, {});
    assertEquals(results.length, 1);
    assertEquals(results[0].workspace, "sub");
  });

  await t.step("workspace is undefined for root repos", () => {
    const results = resolvePaths("api", repos, paths, {});
    assertEquals(results[0].workspace, undefined);
  });

  await t.step("JSON output shape is correct", () => {
    const results = resolvePaths("api", repos, paths, {});
    assertEquals(results.length, 1);
    assertEquals(
      JSON.parse(JSON.stringify(results[0])),
      { name: "api", path: join(paths.repositoriesDirectory, "api") },
    );
  });
});
