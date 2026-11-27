/**
 * lint_imports.ts — Fails if any "../" relative imports remain in src/ or
 * tests/. Internal codebase imports should use the "@" import-map alias.
 *
 * Run with `bun scripts/lint_imports.ts`.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const ROOTS = ["src", "tests"];
const PATTERN = /from\s+["']\.\.\//;

let violations = 0;

for (const root of ROOTS) {
  for (const entry of await readdir(root, { recursive: true })) {
    if (!entry.endsWith(".ts")) continue;
    const path = join(root, entry);
    const text = await readFile(path, "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      if (PATTERN.test(line)) {
        console.error(`${path}:${i + 1}: ${line.trim()}`);
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(
    `\nERROR: Found ${violations} relative "../" import(s). Use the "@" alias instead.`,
  );
  process.exitCode = 1;
} else {
  console.log("OK: no relative ../ imports found");
}
