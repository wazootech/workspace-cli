import { test } from "node:test";
import assert from "node:assert/strict";
import { auditBunReleaseAge } from "@/bun-release-age.ts";
import type { ConfigFile } from "@/config-files.ts";
import { auditDependencyAge, firstPartyScopes } from "@/dependency-age.ts";

const scopes = new Set(["@wazoo"]);

function bunfig(install: string, file = "bunfig.toml"): ConfigFile {
  return { repo: "app", file, text: `[install]\n${install}\n` };
}

function manifest(body: object, file = "package.json"): ConfigFile {
  return { repo: "app", file, text: JSON.stringify(body) };
}

const consumer = manifest({
  name: "app",
  dependencies: { "@wazoo/reasoner": "npm:@jsr/wazoo__reasoner@^1.0.0" },
});

const kinds = (bunfigs: ConfigFile[], manifests: ConfigFile[]) =>
  auditBunReleaseAge(bunfigs, manifests, scopes).map((f) => f.kind);

test("auditBunReleaseAge: passes when the registry name is excluded", () => {
  const config = bunfig(
    'minimumReleaseAge = 86400\nminimumReleaseAgeExcludes = ["@jsr/wazoo__reasoner"]',
  );
  assert.deepEqual(kinds([config], [consumer]), []);
});

test("auditBunReleaseAge: the import name does not exempt a dependency", () => {
  const config = bunfig(
    'minimumReleaseAge = 86400\nminimumReleaseAgeExcludes = ["@wazoo/reasoner"]',
  );
  const findings = auditBunReleaseAge([config], [consumer], scopes);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.kind, "missing-exclude");
  assert.ok(findings[0]!.message.includes("@jsr/wazoo__reasoner"));
});

test("auditBunReleaseAge: flags an unset or zero delay once", () => {
  for (const install of ["", "minimumReleaseAge = 0"]) {
    assert.deepEqual(kinds([bunfig(install)], [consumer]), ["zero-age"]);
  }
});

test("auditBunReleaseAge: reads every dependency section and direct keys", () => {
  const config = bunfig("minimumReleaseAge = 86400");
  const found = auditBunReleaseAge(
    [config],
    [
      manifest({
        devDependencies: { r: "npm:@jsr/wazoo__reasoner@1.0.0" },
        optionalDependencies: { "@jsr/wazoo__tools": "^1.0.0" },
      }),
    ],
    scopes,
  );
  assert.deepEqual(
    found.map((f) => f.message.split(" ")[3]),
    ["@wazoo/reasoner", "@wazoo/tools"],
  );
});

test("auditBunReleaseAge: third-party and own packages need no exclude", () => {
  const config = bunfig("minimumReleaseAge = 86400");
  const own = manifest({
    name: "@wazoo/reasoner",
    dependencies: {
      "@std/path": "npm:@jsr/std__path@^1",
      self: "npm:@jsr/wazoo__reasoner@^1",
      zod: "^3",
    },
  });
  assert.deepEqual(kinds([config], [own]), []);
});

test("auditBunReleaseAge: a nested manifest uses the nearest bunfig", () => {
  const root = bunfig("minimumReleaseAge = 86400");
  const nested = bunfig(
    'minimumReleaseAge = 86400\nminimumReleaseAgeExcludes = ["@jsr/wazoo__reasoner"]',
    "packages/a/bunfig.toml",
  );
  const covered = { ...consumer, file: "packages/a/package.json" };
  const uncovered = { ...consumer, file: "packages/b/package.json" };
  const found = auditBunReleaseAge(
    [root, nested],
    [covered, uncovered],
    scopes,
  );
  assert.deepEqual(
    found.map((f) => f.file),
    ["packages/b/package.json"],
  );
});

test("auditBunReleaseAge: ignores manifests no bunfig governs", () => {
  assert.deepEqual(kinds([], [consumer]), []);
  const broken = bunfig("minimumReleaseAge = ");
  assert.deepEqual(kinds([broken], [consumer]), []);
});

test("firstPartyScopes: a publisher that moved to jsr.json still counts", () => {
  const published = {
    repo: "reasoner",
    file: "jsr.json",
    text: '{"name":"@wazoo/reasoner"}',
  };
  const denoConsumer = {
    repo: "app",
    file: "deno.json",
    config: { imports: { r: "jsr:@wazoo/reasoner@^1" } },
  };
  assert.deepEqual(auditDependencyAge([denoConsumer]), []);
  const found = auditDependencyAge(
    [denoConsumer],
    firstPartyScopes([denoConsumer], [published]),
  );
  assert.deepEqual(
    found.map((f) => f.kind),
    ["missing-exclude"],
  );
});
