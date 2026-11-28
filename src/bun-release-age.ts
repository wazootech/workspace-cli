/**
 * The Bun side of `wspace validate --deps`.
 *
 * Bun delays new releases with `minimumReleaseAge` in `bunfig.toml`, and
 * installs them the moment they appear when it is unset. Exemptions go in
 * `minimumReleaseAgeExcludes` under the registry name: a JSR dependency
 * installed as `"@scope/name": "npm:@jsr/scope__name@…"` is matched only by
 * `@jsr/scope__name`.
 */

import { parse as parseToml } from "@std/toml";
import type { ConfigFile } from "./config-files.ts";
import type { DependencyAgeFinding } from "./dependency-age.ts";
import { parseObject } from "./parse-object.ts";

const SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const JSR_REGISTRY_NAME = /^(?:npm:)?(@jsr\/([^/@]+?)__([^/@]+))(?:@|$)/;

/** The `[install]` table of a bunfig, or undefined when it does not parse. */
function installTable(text: string): Record<string, unknown> | undefined {
  const parsed = parseObject(text, parseToml);
  if (!parsed) return undefined;
  const install = parsed["install"];
  return typeof install === "object" && install !== null
    ? (install as Record<string, unknown>)
    : {};
}

/** JSR dependencies of one package.json: registry name to package name. */
function jsrDependencies(manifest: Record<string, unknown>) {
  const found = new Map<string, string>();
  for (const section of SECTIONS) {
    const entries = Object.entries((manifest[section] as object) ?? {});
    for (const [key, value] of entries) {
      const match =
        JSR_REGISTRY_NAME.exec(String(value)) ?? JSR_REGISTRY_NAME.exec(key);
      if (match) found.set(match[1]!, `@${match[2]}/${match[3]}`);
    }
  }
  return found;
}

/** The nearest bunfig at or above a package.json, within the same repo. */
function bunfigFor(
  manifest: ConfigFile,
  bunfigs: ConfigFile[],
): ConfigFile | undefined {
  const parts = manifest.file.split("/").slice(0, -1);
  for (let depth = parts.length; depth >= 0; depth--) {
    const file = [...parts.slice(0, depth), "bunfig.toml"].join("/");
    const found = bunfigs.find(
      (b) => b.repo === manifest.repo && b.file === file,
    );
    if (found) return found;
  }
  return undefined;
}

/**
 * Audit every package.json that a bunfig governs. Pure; no I/O. Repositories
 * without a bunfig are not Bun projects as far as this audit can tell.
 */
export function auditBunReleaseAge(
  bunfigs: ConfigFile[],
  manifests: ConfigFile[],
  firstPartyScopes: Set<string>,
): DependencyAgeFinding[] {
  const findings: DependencyAgeFinding[] = [];
  for (const { repo, file, text } of bunfigs) {
    const install = installTable(text);
    if (install && !(Number(install["minimumReleaseAge"]) > 0)) {
      findings.push({
        repo,
        file,
        kind: "zero-age",
        message:
          "minimumReleaseAge is unset or 0, so every release installs at once; " +
          "set it to 86400 and exempt first-party packages by name",
      });
    }
  }
  for (const manifest of manifests) {
    const bunfig = bunfigFor(manifest, bunfigs);
    const install = bunfig && installTable(bunfig.text);
    // Without a delay there is nothing to be exempt from.
    if (!install || !(Number(install["minimumReleaseAge"]) > 0)) continue;
    const parsed = parseObject(manifest.text, JSON.parse);
    if (!parsed) continue;
    const listed = install["minimumReleaseAgeExcludes"];
    const excluded = new Set(Array.isArray(listed) ? listed : []);
    for (const [registryName, name] of [...jsrDependencies(parsed)].sort()) {
      if (name === parsed["name"] || excluded.has(registryName)) continue;
      if (!firstPartyScopes.has(name.slice(0, name.indexOf("/")))) continue;
      findings.push({
        repo: manifest.repo,
        file: manifest.file,
        kind: "missing-exclude",
        message: `depends on first-party ${name} but ${bunfig!.file} minimumReleaseAgeExcludes does not list ${registryName}`,
      });
    }
  }
  return findings;
}
