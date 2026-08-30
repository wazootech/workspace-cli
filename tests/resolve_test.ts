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

Deno.test("resolveRepository accepts dotted, underscored, and hyphenated repo names", async (t) => {
  const names = [
    ".github",
    "docs.wazoo.dev",
    "wazoo.dev",
    "my_repo",
    "a.b-c_d.e",
    "foo.bar",
  ];
  for (const name of names) {
    await t.step(`accepts "${name}"`, () => {
      const entry = resolveRepository({ owner: "acme" }, name);
      assertEquals(entry.name, name);
      assertEquals(entry.url, `https://github.com/acme/${name}`);
    });
  }
});

Deno.test("resolveRepository accepts dotted repo name in owner/name shorthand", () => {
  const entry = resolveRepository({}, "acme/docs.wazoo.dev");
  assertEquals(entry.name, "docs.wazoo.dev");
  assertEquals(entry.url, "https://github.com/acme/docs.wazoo.dev");
});

Deno.test("resolveRepository rejects dotted owner segments", () => {
  assertThrows(
    () => resolveRepository({}, "acme.inc/api"),
    Error,
    "Invalid repository owner",
  );
});

Deno.test("resolveRepository rejects reserved and malformed repo names", async (t) => {
  const errorCases: { repo: string; pattern: string }[] = [
    { repo: ".", pattern: "reserved" },
    { repo: "..", pattern: "reserved" },
    { repo: "ends-with.git", pattern: "cannot end with .git" },
    { repo: "a b", pattern: "invalid characters" },
    { repo: "caf\u00e9", pattern: "invalid characters" },
  ];
  for (const { repo, pattern } of errorCases) {
    await t.step(`rejects "${repo}"`, () => {
      assertThrows(
        () => resolveRepository({ owner: "acme" }, repo),
        Error,
        pattern,
      );
    });
  }
});

Deno.test("resolveRepository rejects path traversal via owner segment", () => {
  assertThrows(
    () => resolveRepository({ owner: "acme" }, "../traversal"),
    Error,
    "Invalid repository owner",
  );
});

Deno.test("resolveRepository rejects invalid owner segments", async (t) => {
  const errorCases: { owner: string; pattern: string }[] = [
    { owner: "-owner", pattern: "Invalid repository owner" },
    { owner: "owner-", pattern: "Invalid repository owner" },
    { owner: "my--org", pattern: "Invalid repository owner" },
    { owner: "owner_underscore", pattern: "Invalid repository owner" },
    { owner: "owner.dot", pattern: "Invalid repository owner" },
  ];
  for (const { owner, pattern } of errorCases) {
    await t.step(`rejects owner "${owner}"`, () => {
      assertThrows(
        () => resolveRepository({ owner }, "api"),
        Error,
        pattern,
      );
    });
  }
});

Deno.test("resolveRepository enforces name and owner length caps", () => {
  assertThrows(
    () => resolveRepository({ owner: "acme" }, "x".repeat(101)),
    Error,
    "max 100 characters",
  );
  assertThrows(
    () => resolveRepository({ owner: "o".repeat(40) }, "api"),
    Error,
    "max 39 characters",
  );
});
