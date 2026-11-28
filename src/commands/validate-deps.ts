import { auditBunReleaseAge } from "@/bun-release-age.ts";
import { collectConfigFiles } from "@/config-files.ts";
import {
  auditDependencyAge,
  collectDenoConfigs,
  firstPartyScopes,
} from "@/dependency-age.ts";
import type { ManifestPaths } from "@/manifest.ts";
import { resolveRepositoryPath } from "@/manifest-paths.ts";
import { pathExists } from "@/runtime.ts";
import type { CliOptions } from "@/shared.ts";
import type { WorkspaceManifest } from "@/types.ts";

/**
 * `wspace validate --deps`: audit the release-age delay (Deno's
 * `minimumDependencyAge`, Bun's `minimumReleaseAge`) across every checked-out
 * repository. Missing checkouts are skipped (`install` clones
 * them). Exits 1 when any finding remains.
 */
export async function run(
  opts: CliOptions,
  manifest: WorkspaceManifest,
  paths: ManifestPaths,
): Promise<number> {
  const repoPaths = new Map<string, string>();
  for (const repository of manifest.repositories) {
    const path = resolveRepositoryPath(repository, paths);
    if (await pathExists(path)) repoPaths.set(repository.name, path);
  }

  const configs = await collectDenoConfigs(repoPaths);
  const files = (name: RegExp) => collectConfigFiles(repoPaths, name);
  const scopes = firstPartyScopes(configs, await files(/^jsr\.json$/));
  const findings = [
    ...auditDependencyAge(configs, scopes),
    ...auditBunReleaseAge(
      await files(/^bunfig\.toml$/),
      await files(/^package\.json$/),
      scopes,
    ),
  ];
  if (opts.json) {
    console.log(JSON.stringify(findings, null, 2));
  } else if (findings.length === 0) {
    console.log(
      `Dependency age OK: ${repoPaths.size} checked-out repositories.`,
    );
  } else {
    for (const f of findings) {
      console.error(`${f.repo}/${f.file}: ${f.message}`);
    }
    console.error(`\n${findings.length} dependency-age finding(s).`);
  }
  return findings.length === 0 ? 0 : 1;
}
