import { assertEquals, assertThrows } from "@std/assert";
import { parseRepository, resolveRepository } from "@/resolve.ts";

// parseRepository

Deno.test("parseRepository", async (t) => {
  const successCases: {
    input: string;
    expected: { owner?: string; name: string };
  }[] = [
    { input: "api", expected: { name: "api" } },
    { input: "acme/api", expected: { owner: "acme", name: "api" } },
    { input: "my-org/my-repo", expected: { owner: "my-org", name: "my-repo" } },
    { input: ".github", expected: { name: ".github" } },
    {
      input: "acme/docs.wazoo.dev",
      expected: { owner: "acme", name: "docs.wazoo.dev" },
    },
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

// resolveRepository

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

  await t.step("accepts dotted repo name (.github)", () => {
    assertEquals(
      resolveRepository({ owner: "acme" }, ".github"),
      { name: ".github", url: "https://github.com/acme/.github" },
    );
  });

  await t.step(
    "accepts multi-segment dotted repo name (docs.wazoo.dev)",
    () => {
      assertEquals(
        resolveRepository({ owner: "acme" }, "docs.wazoo.dev"),
        {
          name: "docs.wazoo.dev",
          url: "https://github.com/acme/docs.wazoo.dev",
        },
      );
    },
  );

  await t.step("rejects double-dot path traversal in name", () => {
    assertThrows(
      () => resolveRepository({ owner: "acme" }, "foo..bar"),
      Error,
      "Invalid repository name",
    );
  });

  await t.step("rejects leading .. in name", () => {
    assertThrows(
      () => resolveRepository({ owner: "acme" }, "..secret"),
      Error,
      "Invalid repository name",
    );
  });

  await t.step("rejects trailing .. in name", () => {
    assertThrows(
      () => resolveRepository({ owner: "acme" }, "secret.."),
      Error,
      "Invalid repository name",
    );
  });

  await t.step("rejects dotted owner", () => {
    assertThrows(
      () => resolveRepository({}, { name: "repo", owner: "bad.org" }),
      Error,
      "Invalid repository owner",
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
