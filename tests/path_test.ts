import { assertEquals } from "@std/assert";
import { score } from "@/commands/path.ts";

Deno.test("score", async (t) => {
  await t.step("exact match returns 2", () => {
    assertEquals(score("api", "api"), 2);
  });

  await t.step("case-insensitive exact match returns 1", () => {
    assertEquals(score("API", "api"), 1);
    assertEquals(score("Api", "api"), 1);
  });

  await t.step("substring match returns 0", () => {
    assertEquals(score("my-api", "api"), 0);
    assertEquals(score("api-server", "api"), 0);
    assertEquals(score("worlds-api", "api"), 0);
  });

  await t.step("no match returns -1", () => {
    assertEquals(score("web", "api"), -1);
    assertEquals(score("api", "web"), -1);
    assertEquals(score("api", "xyz"), -1);
  });

  await t.step("empty query matches empty name", () => {
    assertEquals(score("", ""), 2);
  });

  await t.step("partial substring match", () => {
    assertEquals(score("docs.wazoo.dev", "wazoo"), 0);
    assertEquals(score("wazoo-api", "wazoo"), 0);
  });
});
