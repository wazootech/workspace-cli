import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { makeTempDir } from "./helpers.ts";
import { join } from "@std/path";
import { auditDependencyAge, collectDenoConfigs } from "@/dependency-age.ts";
import type { DenoConfigFile } from "@/dependency-age.ts";

const publisher: DenoConfigFile = {
  repo: "reasoner",
  file: "deno.json",
  config: { name: "@wazoo/reasoner", version: "1.0.0" },
};

function consumer(config: Record<string, unknown>): DenoConfigFile {
  return { repo: "app", file: "deno.json", config };
}

test("auditDependencyAge: passes when first-party imports are excluded", () => {
  const findings = auditDependencyAge([
    publisher,
    consumer({
      imports: { r: "jsr:@wazoo/reasoner@^1.0.0", a: "jsr:@std/assert@^1" },
      minimumDependencyAge: { age: "P1D", exclude: ["jsr:@wazoo/reasoner"] },
    }),
  ]);
  assert.deepEqual(findings, []);
});

test("auditDependencyAge: flags a first-party import missing from exclude", () => {
  const findings = auditDependencyAge([
    publisher,
    consumer({ imports: { r: "jsr:@wazoo/reasoner@^1.0.0" } }),
  ]);
  assert.deepEqual(findings.map((f) => [f.repo, f.kind]), [
    ["app", "missing-exclude"],
  ]);
  assert.deepEqual(findings[0].message.includes("jsr:@wazoo/reasoner"), true);
});

test("auditDependencyAge: third-party imports need no exclude", () => {
  const findings = auditDependencyAge([
    publisher,
    consumer({ imports: { a: "jsr:@std/assert@^1", n: "npm:zod@^3" } }),
  ]);
  assert.deepEqual(findings, []);
});

test("auditDependencyAge: flags a zero age, bare or in object form", () => {
  for (const age of [0, { age: 0, exclude: [] }]) {
    const findings = auditDependencyAge([
      publisher,
      consumer({ minimumDependencyAge: age }),
    ]);
    assert.deepEqual(findings.map((f) => f.kind), ["zero-age"]);
  }
});

test("auditDependencyAge: a package's own name is not an import to exclude", () => {
  const findings = auditDependencyAge([
    publisher,
    {
      repo: "reasoner",
      file: "deno.json",
      config: {
        name: "@wazoo/reasoner",
        imports: { self: "jsr:@wazoo/reasoner@^1" },
      },
    },
  ]);
  assert.deepEqual(findings, []);
});

test("collectDenoConfigs: reads deno.json and deno.jsonc, skips node_modules", async () => {
  const root = await makeTempDir();
  try {
    await mkdir(join(root, "sub"));
    await mkdir(join(root, "node_modules", "x"), { recursive: true });
    await writeFile(join(root, "deno.json"), '{"name":"@a/b"}');
    await writeFile(
      join(root, "sub", "deno.jsonc"),
      '// c\n{"imports":{}}',
    );
    await writeFile(
      join(root, "node_modules", "x", "deno.json"),
      "{}",
    );
    const configs = await collectDenoConfigs(new Map([["r", root]]));
    assert.deepEqual(configs.map((c) => c.file).sort(), [
      "deno.json",
      "sub/deno.jsonc",
    ]);
  } finally {
    await rm(root, { recursive: true });
  }
});
