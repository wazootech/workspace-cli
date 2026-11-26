import { test } from "node:test";
import assert from "node:assert/strict";
import { branchAb, configuredUpstream, defaultBranch } from "@/git.ts";
import type { GitResult, GitRunner } from "@/git.ts";

function respond(responses: Record<string, GitResult>): GitRunner {
  return {
    run(args: string[], _cwd?: string): Promise<GitResult> {
      const key = args.join(" ");
      const result = responses[key];
      if (result === undefined) {
        return Promise.reject(new Error(`Unexpected git call: ${key}`));
      }
      return Promise.resolve(result);
    },
  };
}

function ok(stdout: string): GitResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(stderr = ""): GitResult {
  return { code: 1, stdout: "", stderr };
}

test("defaultBranch falls back to origin/main when origin/HEAD missing", async () => {
  const g = respond({
    "symbolic-ref --short refs/remotes/origin/HEAD": fail(),
    "rev-parse --verify refs/remotes/origin/main": ok(
      "refs/remotes/origin/main\n",
    ),
  });
  assert.deepEqual(await defaultBranch(g, "/repo"), "main");
});

test("defaultBranch falls back to origin/master when only master exists", async () => {
  const g = respond({
    "symbolic-ref --short refs/remotes/origin/HEAD": fail(),
    "rev-parse --verify refs/remotes/origin/main": fail(),
    "rev-parse --verify refs/remotes/origin/master": ok(
      "refs/remotes/origin/master\n",
    ),
  });
  assert.deepEqual(await defaultBranch(g, "/repo"), "master");
});

test("defaultBranch returns undefined when no origin remote refs exist", async () => {
  const g = respond({
    "symbolic-ref --short refs/remotes/origin/HEAD": fail(),
    "rev-parse --verify refs/remotes/origin/main": fail(),
    "rev-parse --verify refs/remotes/origin/master": fail(),
  });
  assert.deepEqual(await defaultBranch(g, "/repo"), undefined);
});

test("configuredUpstream resolves remote and merge ref", async () => {
  const g = respond({
    "config --get branch.main.remote": ok("origin"),
    "config --get branch.main.merge": ok("refs/heads/main"),
  });
  assert.deepEqual(await configuredUpstream(g, "/repo", "main"), "origin/main");
});

test("configuredUpstream returns undefined when unset", async () => {
  const g = respond({
    "config --get branch.main.remote": fail(),
    "config --get branch.main.merge": fail(),
  });
  assert.deepEqual(await configuredUpstream(g, "/repo", "main"), undefined);
});

test("branchAb parses tab-separated rev-list fallback", async () => {
  const g = respond({
    "status --porcelain=v2 --branch": ok("# branch.head main"),
    "rev-list --left-right --count HEAD...origin/main": ok("1\t2"),
  });
  assert.deepEqual(await branchAb(g, "/repo", "origin/main"), {
    ahead: 1,
    behind: 2,
  });
});

test("branchAb parses space-separated rev-list fallback", async () => {
  const g = respond({
    "status --porcelain=v2 --branch": ok("# branch.head main"),
    "rev-list --left-right --count HEAD...origin/main": ok("0 0"),
  });
  assert.deepEqual(await branchAb(g, "/repo", "origin/main"), {
    ahead: 0,
    behind: 0,
  });
});

test("branchAb returns undefined when rev-list fails", async () => {
  const g = respond({
    "status --porcelain=v2 --branch": ok("# branch.head main"),
    "rev-list --left-right --count HEAD...origin/main": fail(),
  });
  assert.deepEqual(await branchAb(g, "/repo", "origin/main"), undefined);
});

test("branchAb reads ahead/behind from porcelain v2", async () => {
  const g = respond({
    "status --porcelain=v2 --branch": ok(
      "# branch.head main\n# branch.ab +3 -5",
    ),
  });
  assert.deepEqual(await branchAb(g, "/repo", "origin/main"), {
    ahead: 3,
    behind: 5,
  });
});
