import { test } from "node:test";
import assert from "node:assert/strict";
import { assertThrows } from "./helpers.ts";
import {
  addEntry,
  formatEntry,
  ManifestEditError,
  removeEntry,
} from "@/manifest-edit.ts";

const JSON_FIXTURE = `{
  "schemaVersion": 4,
  "owner": "acme",
  "repositories": [
    "api",
    { "name": "web", "url": "https://gitlab.com/acme/web.git" }
  ]
}`;

test("addEntry appends to a repositories array", () => {
  const out = addEntry(JSON_FIXTURE, '"tool"');
  const doc = JSON.parse(out);
  assert.deepEqual(doc.repositories.length, 3);
  assert.deepEqual(doc.repositories[2], "tool");
});

test("addEntry appends to the optional workspaces array", () => {
  const out = addEntry(JSON_FIXTURE, '"platform"', "workspaces");
  const doc = JSON.parse(out);
  assert.deepEqual(doc.workspaces, ["platform"]);
});

test("addEntry rejects entries without a repositories array", () => {
  assertThrows(
    () => addEntry("{}", '"tool"'),
    ManifestEditError,
    "not an array",
  );
});

test("removeEntry deletes an entry by name", () => {
  const out = removeEntry(JSON_FIXTURE, "api");
  const doc = JSON.parse(out);
  assert.deepEqual(doc.repositories.length, 1);
  assert.deepEqual(doc.repositories[0].name, "web");
});

test("removeEntry resolves owner/name shorthand by expanded name", () => {
  const out = removeEntry(JSON_FIXTURE, "web", "acme");
  const doc = JSON.parse(out);
  assert.deepEqual(doc.repositories.length, 1);
  assert.deepEqual(doc.repositories[0], "api");
});

test("removeEntry throws when target not found", () => {
  assertThrows(
    () => removeEntry(JSON_FIXTURE, "nonexistent"),
    ManifestEditError,
    "not found",
  );
});

test("removeEntry can target a workspaces array", () => {
  const fixture = JSON.stringify({
    repositories: [],
    workspaces: ["platform"],
  });
  const out = removeEntry(
    fixture,
    "platform",
    undefined,
    "github.com",
    "workspaces",
  );
  assert.deepEqual(JSON.parse(out).workspaces, []);
});

test("removeEntry deletes from the workspaces array", () => {
  const fixture = JSON.stringify({
    repositories: [],
    workspaces: ["platform"],
  });
  const out = removeEntry(
    fixture,
    "platform",
    undefined,
    undefined,
    "workspaces",
  );
  const doc = JSON.parse(out);
  assert.deepEqual(doc.workspaces, []);
});

test("formatEntry renders shorthand as JSON string", () => {
  assert.deepEqual(
    formatEntry({ kind: "shorthand", raw: "acme/api" }),
    '"acme/api"',
  );
});

test("formatEntry renders object as JSON object", () => {
  assert.deepEqual(
    formatEntry({ kind: "object", name: "web", url: "https://x.com" }),
    '{ "name": "web", "url": "https://x.com" }',
  );
});
