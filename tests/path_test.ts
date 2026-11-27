import { test } from "node:test";
import assert from "node:assert/strict";
import { score } from "@/commands/path.ts";

test("score", async (t) => {
  await t.test("exact match returns 2", () => {
    assert.deepEqual(score("api", "api"), 2);
  });

  await t.test("case-insensitive exact match returns 1", () => {
    assert.deepEqual(score("API", "api"), 1);
    assert.deepEqual(score("Api", "api"), 1);
  });

  await t.test("substring match returns 0", () => {
    assert.deepEqual(score("my-api", "api"), 0);
    assert.deepEqual(score("api-server", "api"), 0);
    assert.deepEqual(score("worlds-api", "api"), 0);
  });

  await t.test("no match returns -1", () => {
    assert.deepEqual(score("web", "api"), -1);
    assert.deepEqual(score("api", "web"), -1);
    assert.deepEqual(score("api", "xyz"), -1);
  });

  await t.test("empty query matches empty name", () => {
    assert.deepEqual(score("", ""), 2);
  });

  await t.test("partial substring match", () => {
    assert.deepEqual(score("docs.wazoo.dev", "wazoo"), 0);
    assert.deepEqual(score("wazoo-api", "wazoo"), 0);
  });
});
