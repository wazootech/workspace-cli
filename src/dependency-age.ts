/**
 * Dependency-age rule for `wspace validate --deps`.
 *
 * Deno 2.9 refuses to install a JSR or npm release younger than
 * `minimumDependencyAge` (24 hours by default). For packages this workspace
 * publishes itself, that delay either fails CI loudly (exact pins) or silently
 * resolves a caret range to the previous release. The workspace standard is to
 * keep the delay for third-party dependencies and exempt first-party packages
 * by name:
 *
 * ```json
 * "minimumDependencyAge": { "age": "P1D", "exclude": ["jsr:@wazoo/reasoner"] }
 * ```
 *
 * A package is first-party when some checked-out repo's `deno.json` declares a
 * `name` in the same JSR scope. `exclude` takes exact package names, so every
 * imported first-party package must be listed.
 */

import { relative } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { readTextFile, walkDirectoryTree } from "./runtime.ts";

/** One parsed `deno.json` / `deno.jsonc` found inside a repository checkout. */
export interface DenoConfigFile {
  repo: string;
  /** Path relative to the repository root, with forward slashes. */
  file: string;
  config: Record<string, unknown>;
}

export interface DependencyAgeFinding {
  repo: string;
  file: string;
  kind: "zero-age" | "missing-exclude";
  message: string;
}

const CONFIG_NAME = /^deno\.jsonc?$/;
const SKIP = [
  /node_modules/,
  /[\/]\.git([\/]|$)/,
  /[\/]_fresh([\/]|$)/,
  /[\/]dist([\/]|$)/,
  /[\/]vendor([\/]|$)/,
  /[\/]generated([\/]|$)/,
  /[\/]\.wrangler([\/]|$)/,
];

/** Find and parse every Deno config under `repoPaths` (`name` → checkout dir). */
export async function collectDenoConfigs(
  repoPaths: Map<string, string>,
): Promise<DenoConfigFile[]> {
  const found: DenoConfigFile[] = [];
  for (const [repo, root] of repoPaths) {
    const entries = await walkDirectoryTree(root, { skip: SKIP });
    for (const entry of entries) {
      if (entry.isDirectory || !CONFIG_NAME.test(entry.name)) continue;
      let config: unknown;
      try {
        config = parseJsonc(await readTextFile(entry.path));
      } catch {
        continue; // unparseable configs are Deno's to report
      }
      if (typeof config !== "object" || config === null) continue;
      found.push({
        repo,
        file: relative(root, entry.path).replaceAll("\\", "/"),
        config: config as Record<string, unknown>,
      });
    }
  }
  return found;
}

const JSR_SPECIFIER = /^jsr:(@[^/@]+\/[^/@]+)/;

function scopeOf(packageName: string): string | undefined {
  return /^(@[^/]+)\//.exec(packageName)?.[1];
}

function isZeroAge(value: unknown): boolean {
  if (value === 0 || value === "0") return true;
  if (typeof value === "object" && value !== null) {
    const age = (value as { age?: unknown }).age;
    return age === 0 || age === "0";
  }
  return false;
}

function excludedNames(value: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof value === "object" && value !== null) {
    const exclude = (value as { exclude?: unknown }).exclude;
    if (Array.isArray(exclude)) {
      for (const item of exclude) {
        if (typeof item === "string") names.add(item);
      }
    }
  }
  return names;
}

/** Apply the rule to already-parsed configs. Pure; no I/O. */
export function auditDependencyAge(
  configs: DenoConfigFile[],
): DependencyAgeFinding[] {
  const firstPartyScopes = new Set<string>();
  for (const { config } of configs) {
    if (typeof config.name === "string") {
      const scope = scopeOf(config.name);
      if (scope) firstPartyScopes.add(scope);
    }
  }

  const findings: DependencyAgeFinding[] = [];
  for (const { repo, file, config } of configs) {
    const age = config.minimumDependencyAge;
    if (isZeroAge(age)) {
      findings.push({
        repo,
        file,
        kind: "zero-age",
        message:
          "minimumDependencyAge is 0, which disables the delay for every dependency; " +
          'use {"age": "P1D", "exclude": [...]} to exempt first-party packages only',
      });
    }

    const imports = config.imports;
    if (typeof imports !== "object" || imports === null) continue;
    const excluded = excludedNames(age);
    const missing = new Set<string>();
    for (const specifier of Object.values(imports)) {
      if (typeof specifier !== "string") continue;
      const name = JSR_SPECIFIER.exec(specifier)?.[1];
      if (!name || config.name === name) continue;
      const scope = scopeOf(name);
      if (
        scope && firstPartyScopes.has(scope) && !excluded.has(`jsr:${name}`)
      ) {
        missing.add(`jsr:${name}`);
      }
    }
    // A zero age already exempts everything; the zero-age finding covers it.
    if (isZeroAge(age)) continue;
    for (const name of [...missing].sort()) {
      findings.push({
        repo,
        file,
        kind: "missing-exclude",
        message:
          `imports first-party ${name} but minimumDependencyAge.exclude does not list it`,
      });
    }
  }
  return findings;
}
