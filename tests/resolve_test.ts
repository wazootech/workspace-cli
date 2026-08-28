import { assertEquals, assertThrows } from "@std/assert";
import {
  parseRepository,
  resolveRepository,
  resolveWorkspace,
} from "@/resolve.ts";

// ---------------------------------------------------------------------------
// parseRepository
// ---------------------------------------------------------------------------

Deno.test("parseRepository", async (t) => {
  const successCases: {
    input: string;
    expected: { owner?: string; name: string };
  }[] = [
    { input: "api", expected: { name: "api" } },
    { input: "acme/api", expected: { owner: "acme", name: "api" } },
    { input: "my-org/my-repo", expected: { owner: "my-org", name: "my-repo" } },
  ];

  for (const { input, expected } of successCases) {
    await t.step(`parses "${input}"`, () => {
      assertEquals(parseRepository(input), expected);
    });
  }

  const errorCases: { input: string; pattern: string }[] = [
    { input: "a/b/c", pattern: "Unable to parse repository string" },
    { input: "/api", pattern: "Unable to parse repository string" },
    { input: "acme/", pattern: "Unable to parse repository string" },
    { input: "", pattern: "Unable to parse repository string" },
  ];

  for (const { input, pattern } of errorCases) {
    await t.step(`rejects "${input}"`, () => {
      assertThrows(() => parseRepository(input), Error, pattern);
    });
  }
});

// ---------------------------------------------------------------------------
// resolveRepository
// ---------------------------------------------------------------------------

Deno.test("resolveRepository", async (t) => {
  await t.step("expands bare string with workspace owner", () => {
    assertEquals(
      resolveRepository({ owner: "acme" }, "api"),
      { name: "api", url: "https://github.com/acme/api" },
    );
  });

  await t.step("expands owner/name inline shorthand", () => {
    assertEquals(
      resolveRepository({ owner: "acme" }, "other/repo"),
      { name: "repo", url: "https://github.com/other/repo" },
    );
  });

  await t.step("inline owner overrides workspace owner", () => {
    assertEquals(
      resolveRepository({ owner: "acme" }, {
        name: "repo",
        owner: "other",
      }),
      { name: "repo", url: "https://github.com/other/repo" },
    );
  });

  await t.step("passthrough explicit url", () => {
    assertEquals(
      resolveRepository(
        { owner: "acme" },
        { name: "custom", url: "https://gitlab.com/x/y.git" },
      ),
      { name: "custom", url: "https://gitlab.com/x/y.git" },
    );
  });

  await t.step("uses custom host from repository", () => {
    assertEquals(
      resolveRepository({ owner: "acme" }, {
        name: "api",
        host: "gitlab.com",
      }),
      { name: "api", url: "https://gitlab.com/acme/api" },
    );
  });

  await t.step("normalizes bare hostname to https", () => {
    assertEquals(
      resolveRepository(
        { host: "github.com", owner: "acme" },
        "api",
      ),
      { name: "api", url: "https://github.com/acme/api" },
    );
  });

  const errorCases: {
    workspace: { host?: string; owner?: string };
    repo: string | { name: string; url?: string };
    pattern: string;
  }[] = [
    {
      workspace: {},
      repo: "api",
      pattern: "Invalid repository owner",
    },
    {
      workspace: { owner: "acme" },
      repo: { name: "", url: undefined },
      pattern: "Invalid repository name",
    },
  ];

  for (const { workspace, repo, pattern } of errorCases) {
    await t.step(`throws on ${pattern}`, () => {
      assertThrows(
        () => resolveRepository(workspace, repo),
        Error,
        pattern,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// resolveWorkspace
// ---------------------------------------------------------------------------

Deno.test("resolveWorkspace maps all repositories", () => {
  const result = resolveWorkspace({
    owner: "acme",
    repositories: ["api", "other/repo"],
  });
  assertEquals(result.repositories.length, 2);
  assertEquals(result.repositories[0], {
    name: "api",
    url: "https://github.com/acme/api",
  });
  assertEquals(result.repositories[1], {
    name: "repo",
    url: "https://github.com/other/repo",
  });
});

Deno.test("resolveWorkspace preserves host and owner", () => {
  const result = resolveWorkspace({
    host: "gitlab.com",
    owner: "acme",
    repositories: ["api"],
  });
  assertEquals(result.host, "gitlab.com");
  assertEquals(result.owner, "acme");
});
