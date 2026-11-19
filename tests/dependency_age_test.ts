import { assertEquals } from "@std/assert";
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

Deno.test("auditDependencyAge: passes when first-party imports are excluded", () => {
  const findings = auditDependencyAge([
    publisher,
    consumer({
      imports: { r: "jsr:@wazoo/reasoner@^1.0.0", a: "jsr:@std/assert@^1" },
      minimumDependencyAge: { age: "P1D", exclude: ["jsr:@wazoo/reasoner"] },
    }),
  ]);
  assertEquals(findings, []);
});

Deno.test("auditDependencyAge: flags a first-party import missing from exclude", () => {
  const findings = auditDependencyAge([
    publisher,
    consumer({ imports: { r: "jsr:@wazoo/reasoner@^1.0.0" } }),
  ]);
  assertEquals(findings.map((f) => [f.repo, f.kind]), [
    ["app", "missing-exclude"],
  ]);
  assertEquals(findings[0].message.includes("jsr:@wazoo/reasoner"), true);
});

Deno.test("auditDependencyAge: third-party imports need no exclude", () => {
  const findings = auditDependencyAge([
    publisher,
    consumer({ imports: { a: "jsr:@std/assert@^1", n: "npm:zod@^3" } }),
  ]);
  assertEquals(findings, []);
});

Deno.test("auditDependencyAge: flags a zero age, bare or in object form", () => {
  for (const age of [0, { age: 0, exclude: [] }]) {
    const findings = auditDependencyAge([
      publisher,
      consumer({ minimumDependencyAge: age }),
    ]);
    assertEquals(findings.map((f) => f.kind), ["zero-age"]);
  }
});

Deno.test("auditDependencyAge: a package's own name is not an import to exclude", () => {
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
  assertEquals(findings, []);
});

Deno.test("collectDenoConfigs: reads deno.json and deno.jsonc, skips node_modules", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "sub"));
    await Deno.mkdir(join(root, "node_modules", "x"), { recursive: true });
    await Deno.writeTextFile(join(root, "deno.json"), '{"name":"@a/b"}');
    await Deno.writeTextFile(
      join(root, "sub", "deno.jsonc"),
      '// c\n{"imports":{}}',
    );
    await Deno.writeTextFile(
      join(root, "node_modules", "x", "deno.json"),
      "{}",
    );
    const configs = await collectDenoConfigs(new Map([["r", root]]));
    assertEquals(configs.map((c) => c.file).sort(), [
      "deno.json",
      "sub/deno.jsonc",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
