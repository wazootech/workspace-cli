import { assertEquals } from "@std/assert";
import { classifyState, collectStatus } from "@/status.ts";
import type { ClassifyInput } from "@/status.ts";
import { hasErrors } from "@/status.ts";
import type { GitRunner } from "@/git.ts";
import type { RepoStatus } from "@/types.ts";

function input(overrides: Partial<ClassifyInput>): ClassifyInput {
  return {
    dirty: false,
    featureBranch: false,
    hasDefaultBranch: true,
    upstream: "origin/main",
    upstreamRefExists: true,
    aheadBehind: { ahead: 0, behind: 0 },
    ...overrides,
  };
}

Deno.test("classifyState: clean when in sync on default branch", () => {
  assertEquals(classifyState(input({})).state, "CLEAN");
});

Deno.test("classifyState: dirty wins over everything", () => {
  const result = classifyState(
    input({ dirty: true, aheadBehind: { ahead: 1, behind: 2 } }),
  );
  assertEquals(result.state, "DIRTY");
});

Deno.test("classifyState: feature branch is clean regardless of divergence", () => {
  assertEquals(
    classifyState(
      input({ featureBranch: true, aheadBehind: { ahead: 1, behind: 2 } }),
    ).state,
    "FEATURE_CLEAN",
  );
});

Deno.test("classifyState: diverged reports ahead/behind detail", () => {
  const result = classifyState(input({ aheadBehind: { ahead: 1, behind: 2 } }));
  assertEquals(result.state, "DIVERGED");
  assertEquals(result.detail, "1 ahead, 2 behind");
});

Deno.test("classifyState: no origin/HEAD", () => {
  const result = classifyState(input({ hasDefaultBranch: false }));
  assertEquals(result.state, "UNKNOWN");
  assertEquals(result.detail, "no origin/HEAD");
});

Deno.test("classifyState: missing upstream", () => {
  const result = classifyState(input({ upstream: undefined }));
  assertEquals(result.state, "UNKNOWN");
  assertEquals(result.detail, "no upstream configured");
});

Deno.test("classifyState: missing tracking ref", () => {
  const result = classifyState(input({ upstreamRefExists: false }));
  assertEquals(result.state, "UNKNOWN");
  assertEquals(result.detail, "missing tracking ref");
});

Deno.test("hasErrors is false for clean work", () => {
  const rows: RepoStatus[] = [
    { name: "a", path: "/a", state: "CLEAN" },
    { name: "b", path: "/b", state: "FEATURE_CLEAN" },
  ];
  assertEquals(hasErrors(rows), false);
});

Deno.test("hasErrors is true for any non-clean state", () => {
  const rows: RepoStatus[] = [
    { name: "a", path: "/a", state: "CLEAN" },
    { name: "b", path: "/b", state: "DIVERGED" },
  ];
  assertEquals(hasErrors(rows), true);
});

Deno.test("collectStatus reports error-marked workspace entries as INVALID rows", async () => {
  const rows = await collectStatus(
    {} as GitRunner,
    {
      repositories: [{
        name: "platform",
        url: "",
        error:
          'Workspace repository "platform" at /ws/repos/platform does not contain a workspace.json manifest',
      }],
    },
    { root: "/ws", repositoriesDirectory: "/ws/repos" },
    { includeRoot: false },
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].name, "platform");
  assertEquals(rows[0].state, "INVALID");
  assertEquals(
    rows[0].detail,
    'Workspace repository "platform" at /ws/repos/platform does not contain a workspace.json manifest',
  );
  assertEquals(hasErrors(rows), true);
});
