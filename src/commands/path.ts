import { relative } from "@std/path";
import { walk } from "@std/fs/walk";
import type { ManifestPaths } from "@/manifest.ts";
import type { CliOptions } from "@/shared.ts";
import type { WorkspaceManifest } from "@/types.ts";

export interface PathResult {
  /** Display name — the directory basename. */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Relative path from workspace root (human-friendly). */
  rel: string;
}

/**
 * Score a name against a query. Higher = better match.
 * -1 = no match, 0 = substring, 1 = case-insensitive exact, 2 = exact.
 */
export function score(name: string, query: string): number {
  if (name === query) return 2;
  if (name.toLowerCase() === query.toLowerCase()) return 1;
  if (name.toLowerCase().includes(query.toLowerCase())) return 0;
  return -1;
}

/**
 * Walk the workspace tree in a single pass, returning directories that
 * match the query.
 *
 * Depth rules (from workspace root):
 * - repos/children: depth 1 only (repo names)
 * - other top-level dirs: depth 1 (nested sub-workspaces)
 */
async function searchWorkspace(
  query: string,
  paths: ManifestPaths,
): Promise<PathResult[]> {
  const results: PathResult[] = [];
  const rootLen = paths.root.length;

  // Depth limits per top-level directory (relative to that dir, not root).
  // other: 1 (nested sub-workspace dirs).
  const depthLimit = new Map([
    ["repos", 1],
  ]);

  try {
    for await (
      const entry of walk(paths.root, {
        maxDepth: 3,
        includeFiles: false,
        skip: [/^\./, /node_modules/, /^\.git$/],
      })
    ) {
      if (entry.path === paths.root) continue;
      if (!entry.isDirectory) continue;
      // Prune: skip entries deeper than their top-level dir allows.
      // Depth is from root; subtract 1 for the top-level dir itself.
      // +1 also skips the path separator (manifestPaths normalizes without trailing sep).
      const rel = entry.path.slice(rootLen + 1);
      const segments = rel.split(/[\\/]/);
      if (segments.length > 1) {
        const topDir = segments[0];
        const limit = depthLimit.get(topDir) ?? 1;
        const depthFromDir = segments.length - 1;
        if (depthFromDir > limit) continue;
      }
      if (score(entry.name, query) >= 0) {
        results.push({
          name: entry.name,
          path: entry.path,
          rel: relative(paths.root, entry.path),
        });
      }
    }
  } catch {
    // Root doesn't exist or permission error.
  }

  return results;
}

/**
 * Sort results: exact matches first, then case-insensitive, then substring.
 * Within each tier, sort alphabetically.
 */
function sortResults(results: PathResult[], query: string): PathResult[] {
  return [...results].sort((a, b) => {
    const sa = score(a.name, query);
    const sb = score(b.name, query);
    if (sb !== sa) return sb - sa; // higher score first
    return a.rel.localeCompare(b.rel);
  });
}

export async function run(
  opts: CliOptions,
  _manifest: WorkspaceManifest,
  paths: ManifestPaths,
): Promise<number> {
  const query = opts.positional[0];
  if (!query) {
    console.error(
      "Usage: wspace path <query> [--json]",
    );
    return 2;
  }

  const raw = await searchWorkspace(query, paths);
  const results = sortResults(raw, query);

  if (results.length === 0) {
    console.error(`No match for "${query}"`);
    return 1;
  }

  if (results.length > 1 && !opts.json) {
    // Ambiguous — print candidates on stderr, empty stdout.
    console.error(`Multiple matches for "${query}":`);
    for (const r of results.slice(0, 15)) {
      console.error(`  ${r.rel}`);
    }
    if (results.length > 15) {
      console.error(`  ... and ${results.length - 15} more`);
    }
    return 1;
  }

  // Single match or --json: print to stdout.
  const output = opts.json ? results : [results[0]];
  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(results[0].path);
  }
  return 0;
}
