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
 * Skip patterns: hidden dirs, node_modules, .git.
 */
const SKIP = [/^\./, /node_modules/, /^\.git$/];

/**
 * Walk a directory using @std/fs/walk, returning directories that match
 * the query. maxDepth controls how deep to search.
 */
async function searchDir(
  dir: string,
  query: string,
  workspaceRoot: string,
  maxDepth: number,
): Promise<PathResult[]> {
  const results: PathResult[] = [];
  try {
    for await (
      const entry of walk(dir, {
        maxDepth,
        includeFiles: false,
        skip: SKIP,
      })
    ) {
      if (entry.path === dir) continue; // skip root itself
      if (score(entry.name, query) >= 0) {
        results.push({
          name: entry.name,
          path: entry.path,
          rel: relative(workspaceRoot, entry.path),
        });
      }
    }
  } catch {
    // Directory doesn't exist or permission error.
  }
  return results;
}

/**
 * Search for directories matching the query across the workspace tree.
 * Uses @std/fs/walk to traverse repos/, worktrees/, and nested
 * sub-workspace directories.
 */
async function searchWorkspace(
  query: string,
  paths: ManifestPaths,
): Promise<PathResult[]> {
  const all: PathResult[] = [];

  // 1. repos/ — immediate children (depth 1)
  all.push(
    ...await searchDir(
      paths.repositoriesDirectory,
      query,
      paths.root,
      1,
    ),
  );

  // 2. worktrees/ — two levels deep (repo/feature)
  all.push(
    ...await searchDir(paths.worktreesDirectory, query, paths.root, 2),
  );

  // 3. Top-level directories not in repos/worktrees/secrets
  //    (handles nested sub-workspaces)
  try {
    const skip = new Set([
      "repos",
      "worktrees",
      "secrets",
      "node_modules",
      ".git",
    ]);
    for await (
      const entry of walk(paths.root, {
        maxDepth: 1,
        includeFiles: false,
        skip: SKIP,
      })
    ) {
      if (entry.path === paths.root) continue;
      if (!entry.isDirectory || skip.has(entry.name)) continue;
      all.push(
        ...await searchDir(
          entry.path,
          query,
          paths.root,
          1,
        ),
      );
    }
  } catch {
    // Root doesn't exist.
  }

  return all;
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
