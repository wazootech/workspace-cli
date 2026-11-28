/** Find the manifests the dependency audits read, in every checked-out repo. */

import { relative } from "@std/path";
import { readTextFile, walkDirectoryTree } from "./runtime.ts";

/** One manifest found inside a repository checkout. */
export interface ConfigFile {
  repo: string;
  /** Path relative to the repository root, with forward slashes. */
  file: string;
  text: string;
}

const SKIP = [
  /node_modules/,
  /[/]\.git([/]|$)/,
  /[/]_fresh([/]|$)/,
  /[/]dist([/]|$)/,
  /[/]vendor([/]|$)/,
  /[/]generated([/]|$)/,
  /[/]\.wrangler([/]|$)/,
];

/** Read every file whose basename matches `name` under `repoPaths`. */
export async function collectConfigFiles(
  repoPaths: Map<string, string>,
  name: RegExp,
): Promise<ConfigFile[]> {
  const found: ConfigFile[] = [];
  for (const [repo, root] of repoPaths) {
    const entries = await walkDirectoryTree(root, { skip: SKIP });
    for (const entry of entries) {
      if (entry.isDirectory || !name.test(entry.name)) continue;
      found.push({
        repo,
        file: relative(root, entry.path).replaceAll("\\", "/"),
        text: await readTextFile(entry.path),
      });
    }
  }
  return found;
}
