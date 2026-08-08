import { assertEquals } from "@std/assert";
import { branchAb, configuredUpstream, defaultBranch } from "../src/git.ts";
import type { GitResult, GitRunner } from "../src/git.ts";

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

Deno.test("defaultBranch returns undefined when origin/HEAD missing", async () => {
  const g = respond({
    "symbolic-ref --short refs/remotes/origin/HEAD": fail(),
  });
  assertEquals(await defaultBranch(g, "/repo"), undefined);
});

Deno.test("configuredUpstream resolves remote and merge ref", async () => {
  const g = respond({
    "config --get branch.main.remote": ok("origin"),
    "config --get branch.main.merge": ok("refs/heads/main"),
  });
  assertEquals(await configuredUpstream(g, "/repo", "main"), "origin/main");
});

Deno.test("configuredUpstream returns undefined when unset", async () => {
  const g = respond({
    "config --get branch.main.remote": fail(),
    "config --get branch.main.merge": fail(),
  });
  assertEquals(await configuredUpstream(g, "/repo", "main"), undefined);
});

Deno.test("branchAb parses tab-separated rev-list fallback", async () => {
  const g = respond({
    "status --porcelain=v2 --branch": ok("# branch.head main"),
    "rev-list --left-right --count HEAD...origin/main": ok("1\t2"),
  });
  assertEquals(await branchAb(g, "/repo", "origin/main"), {
    ahead: 1,
    behind: 2,
  });
});

Deno.test("branchAb parses space-separated rev-list fallback", async () => {
  const g = respond({
    "status --porcelain=v2 --branch": ok("# branch.head main"),
    "rev-list --left-right --count HEAD...origin/main": ok("0 0"),
  });
  assertEquals(await branchAb(g, "/repo", "origin/main"), {
    ahead: 0,
    behind: 0,
  });
});

Deno.test("branchAb returns undefined when rev-list fails", async () => {
  const g = respond({
    "status --porcelain=v2 --branch": ok("# branch.head main"),
    "rev-list --left-right --count HEAD...origin/main": fail(),
  });
  assertEquals(await branchAb(g, "/repo", "origin/main"), undefined);
});

Deno.test("branchAb reads ahead/behind from porcelain v2", async () => {
  const g = respond({
    "status --porcelain=v2 --branch": ok(
      "# branch.head main\n# branch.ab +3 -5",
    ),
  });
  assertEquals(await branchAb(g, "/repo", "origin/main"), {
    ahead: 3,
    behind: 5,
  });
});
