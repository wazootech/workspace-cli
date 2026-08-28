/**
 * lint_imports.ts — Fails if any "../" relative imports remain in src/ or
 * tests/. Internal codebase imports should use the "@" import-map alias.
 */

import { walk } from "@std/fs/walk";

const ROOTS = ["src", "tests"];
const PATTERN = /from\s+["']\.\.\//;

let violations = 0;

for (const root of ROOTS) {
  for await (const entry of walk(root, { exts: [".ts"] })) {
    const text = await Deno.readTextFile(entry.path);
    for (const [i, line] of text.split("\n").entries()) {
      if (PATTERN.test(line)) {
        console.error(`${entry.path}:${i + 1}: ${line.trim()}`);
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(
    `\nERROR: Found ${violations} relative "../" import(s). Use the "@" alias instead.`,
  );
  Deno.exit(1);
}

console.log("OK: no relative ../ imports found");
