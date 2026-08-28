import { assertEquals, assertThrows } from "@std/assert";
import type { GitResult, GitRunner } from "@/git.ts";
import {
  addEntryJsonc,
  ManifestEditError,
  removeEntryJsonc,
} from "@/manifest-edit.ts";
import { createGitHubRepo, probeGitHubRepo } from "@/remote.ts";

const JSONC_FIXTURE = `{
  // team workspace
  "schemaVersion": 4,
  "owner": "acme",
  "repositories": [
    /* core */
    "api",
    { "name": "web", "url": "https://gitlab.com/acme/web.git" },
  ],
}
`;

Deno.test("addEntryJsonc appends to a multiline array preserving comments", () => {
  const out = addEntryJsonc(JSONC_FIXTURE, '"tool"');
  assertEquals(
    out,
    `{
  // team workspace
  "schemaVersion": 4,
  "owner": "acme",
  "repositories": [
    /* core */
    "api",
    { "name": "web", "url": "https://gitlab.com/acme/web.git" },
    "tool",
  ],
}
`,
  );
});

Deno.test("removeEntryJsonc deletes an entry and its comma", () => {
  const out = removeEntryJsonc(JSONC_FIXTURE, "api", "acme");
  assertEquals(
    out,
    `{
  // team workspace
  "schemaVersion": 4,
  "owner": "acme",
  "repositories": [
    /* core */
    { "name": "web", "url": "https://gitlab.com/acme/web.git" },
  ],
}
`,
  );
});

Deno.test("removeEntryJsonc resolves owner/name shorthand by expanded name", () => {
  const fixture = `{"repositories": ["acme/tool", "other"]}`;
  const out = removeEntryJsonc(fixture, "tool", undefined);
  assertEquals(out, `{"repositories": ["other"]}`);
});

Deno.test("removeEntryJsonc removes the last element without a preceding comma", () => {
  const fixture = `{"repositories": [\n  "keep",\n  "gone"\n]}`;
  const out = removeEntryJsonc(fixture, "gone", "acme");
  assertEquals(out, `{"repositories": [\n  "keep"\n]}`);
});

Deno.test("addEntryJsonc keeps single-line arrays single-line", () => {
  const fixture = `{"owner": "a", "repositories": ["x", "y"]}`;
  assertEquals(
    addEntryJsonc(fixture, '"z"'),
    `{"owner": "a", "repositories": ["x", "y", "z"]}`,
  );
});

Deno.test("addEntryJsonc expands an empty inline array into a block", () => {
  const fixture = `{\n  "owner": "acme",\n  "repositories": []\n}\n`;
  assertEquals(
    addEntryJsonc(fixture, '"api"'),
    `{\n  "owner": "acme",\n  "repositories": [\n    "api"\n  ]\n}\n`,
  );
});

Deno.test("addEntryJsonc fails closed on a comment-only array", () => {
  const fixture = `{ "repositories": [ /* none yet */ ] }`;
  assertThrows(
    () => addEntryJsonc(fixture, '"api"'),
    ManifestEditError,
  );
});

Deno.test("jsonc edits preserve CRLF line endings outside touched spans", () => {
  const fixture =
    `{\r\n  "repositories": [\r\n    "a",\r\n    "b"\r\n  ]\r\n}\r\n`;
  const out = addEntryJsonc(fixture, '"c"');
  assertEquals(
    out,
    `{\r\n  "repositories": [\r\n    "a",\r\n    "b",\r\n    "c"\r\n  ]\r\n}\r\n`,
  );
});

class FakeGh implements GitRunner {
  calls: string[][] = [];
  constructor(
    private readonly script: (args: string[]) => Partial<GitResult>,
  ) {}
  run(args: string[]): Promise<GitResult> {
    this.calls.push(args);
    const scripted = this.script(args);
    return Promise.resolve({
      code: scripted.code ?? 0,
      stdout: scripted.stdout ?? "",
      stderr: scripted.stderr ?? "",
    });
  }
}

Deno.test("probeGitHubRepo classifies found, missing, and error outcomes", async () => {
  const found = new FakeGh(() => ({ code: 0 }));
  assertEquals(await probeGitHubRepo(found, "acme/api"), { status: "found" });

  const missing = new FakeGh(() => ({
    code: 1,
    stderr: "GraphQL: Could not resolve to a Repository",
  }));
  assertEquals(await probeGitHubRepo(missing, "acme/api"), {
    status: "missing",
    stderr: "GraphQL: Could not resolve to a Repository",
  });

  const authError = new FakeGh(() => ({
    code: 1,
    stderr: "gh auth required",
  }));
  const probe = await probeGitHubRepo(authError, "acme/api");
  assertEquals(probe.status, "error");
});

Deno.test("createGitHubRepo passes the slug and default visibility", async () => {
  const gh = new FakeGh(() => ({ code: 0 }));
  const result = await createGitHubRepo(gh, "acme/api", "private");
  assertEquals(result, { ok: true });
  assertEquals(gh.calls, [["repo", "create", "acme/api", "--private"]]);
});
