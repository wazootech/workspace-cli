import { assertEquals } from "@std/assert";
import { isLocalConfigFile } from "@/env.ts";

Deno.test("isLocalConfigFile matches default patterns", () => {
  assertEquals(isLocalConfigFile(".env"), true);
  assertEquals(isLocalConfigFile(".env.qa"), true);
  assertEquals(isLocalConfigFile(".dev.vars"), true);
  assertEquals(isLocalConfigFile(".dev.vars.production"), true);
});

Deno.test("isLocalConfigFile excludes examples and templates", () => {
  assertEquals(isLocalConfigFile(".env.example"), false);
  assertEquals(isLocalConfigFile(".env.template"), false);
});

Deno.test("isLocalConfigFile excludes unrelated files", () => {
  assertEquals(isLocalConfigFile("package.json"), false);
  assertEquals(isLocalConfigFile("README.md"), false);
  assertEquals(isLocalConfigFile("deno.json"), false);
});

Deno.test("isLocalConfigFile honors extra patterns", () => {
  assertEquals(
    isLocalConfigFile("credentials.toml", ["credentials.toml"]),
    true,
  );
  assertEquals(isLocalConfigFile("credentials.toml"), false);
});
