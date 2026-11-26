import { test } from "node:test";
import assert from "node:assert/strict";
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

test("classifyState: clean when in sync on default branch", () => {
  assert.deepEqual(classifyState(input({})).state, "CLEAN");
});

test("classifyState: dirty wins over everything", () => {
  const result = classifyState(
    input({ dirty: true, aheadBehind: { ahead: 1, behind: 2 } }),
  );
  assert.deepEqual(result.state, "DIRTY");
});

test("classifyState: feature branch is clean regardless of divergence", () => {
  assert.deepEqual(
    classifyState(
      input({ featureBranch: true, aheadBehind: { ahead: 1, behind: 2 } }),
    ).state,
    "FEATURE_CLEAN",
  );
});

test("classifyState: diverged reports ahead/behind detail", () => {
  const result = classifyState(input({ aheadBehind: { ahead: 1, behind: 2 } }));
  assert.deepEqual(result.state, "DIVERGED");
  assert.deepEqual(result.detail, "1 ahead, 2 behind");
});

test("classifyState: no origin/HEAD", () => {
  const result = classifyState(input({ hasDefaultBranch: false }));
  assert.deepEqual(result.state, "UNKNOWN");
  assert.deepEqual(result.detail, "no origin/HEAD");
});

test("classifyState: missing upstream", () => {
  const result = classifyState(input({ upstream: undefined }));
  assert.deepEqual(result.state, "UNKNOWN");
  assert.deepEqual(result.detail, "no upstream configured");
});

test("classifyState: missing tracking ref", () => {
  const result = classifyState(input({ upstreamRefExists: false }));
  assert.deepEqual(result.state, "UNKNOWN");
  assert.deepEqual(result.detail, "missing tracking ref");
});

test("hasErrors is false for clean work", () => {
  const rows: RepoStatus[] = [
    { name: "a", path: "/a", state: "CLEAN" },
    { name: "b", path: "/b", state: "FEATURE_CLEAN" },
  ];
  assert.deepEqual(hasErrors(rows), false);
});

test("hasErrors is true for any non-clean state", () => {
  const rows: RepoStatus[] = [
    { name: "a", path: "/a", state: "CLEAN" },
    { name: "b", path: "/b", state: "DIVERGED" },
  ];
  assert.deepEqual(hasErrors(rows), true);
});

test("collectStatus reports error-marked workspace entries as INVALID rows", async () => {
  const rows = await collectStatus(
    {} as GitRunner,
    {
      repositories: [
        {
          name: "platform",
          url: "",
          error:
            'Workspace repository "platform" at /ws/repos/platform does not contain a workspace.json manifest',
        },
      ],
    },
    { root: "/ws", repositoriesDirectory: "/ws/repos" },
    { includeRoot: false },
  );
  assert.deepEqual(rows.length, 1);
  assert.deepEqual(rows[0].name, "platform");
  assert.deepEqual(rows[0].state, "INVALID");
  assert.deepEqual(
    rows[0].detail,
    'Workspace repository "platform" at /ws/repos/platform does not contain a workspace.json manifest',
  );
  assert.deepEqual(hasErrors(rows), true);
});
