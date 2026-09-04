import { assertEquals, assertThrows } from "@std/assert";
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

Deno.test("addEntry appends to a repositories array", () => {
  const out = addEntry(JSON_FIXTURE, '"tool"');
  const doc = JSON.parse(out);
  assertEquals(doc.repositories.length, 3);
  assertEquals(doc.repositories[2], "tool");
});

Deno.test("addEntry appends to the optional workspaces array", () => {
  const out = addEntry(JSON_FIXTURE, '"platform"', "workspaces");
  const doc = JSON.parse(out);
  assertEquals(doc.workspaces, ["platform"]);
});

Deno.test("addEntry rejects entries without a repositories array", () => {
  assertThrows(
    () => addEntry("{}", '"tool"'),
    ManifestEditError,
    "not an array",
  );
});

Deno.test("removeEntry deletes an entry by name", () => {
  const out = removeEntry(JSON_FIXTURE, "api");
  const doc = JSON.parse(out);
  assertEquals(doc.repositories.length, 1);
  assertEquals(doc.repositories[0].name, "web");
});

Deno.test("removeEntry resolves owner/name shorthand by expanded name", () => {
  const out = removeEntry(JSON_FIXTURE, "web", "acme");
  const doc = JSON.parse(out);
  assertEquals(doc.repositories.length, 1);
  assertEquals(doc.repositories[0], "api");
});

Deno.test("removeEntry throws when target not found", () => {
  assertThrows(
    () => removeEntry(JSON_FIXTURE, "nonexistent"),
    ManifestEditError,
    "not found",
  );
});

Deno.test("removeEntry can target a workspaces array", () => {
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
  assertEquals(JSON.parse(out).workspaces, []);
});

Deno.test("removeEntry deletes from the workspaces array", () => {
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
  assertEquals(doc.workspaces, []);
});

Deno.test("formatEntry renders shorthand as JSON string", () => {
  assertEquals(
    formatEntry({ kind: "shorthand", raw: "acme/api" }),
    '"acme/api"',
  );
});

Deno.test("formatEntry renders object as JSON object", () => {
  assertEquals(
    formatEntry({ kind: "object", name: "web", url: "https://x.com" }),
    '{ "name": "web", "url": "https://x.com" }',
  );
});
