import { join, relative } from "@std/path";
import { existsSync } from "@std/fs";
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
 * Walk a directory up to `depth` levels deep, returning directories that
 * match the query. depth=1 means immediate children only.
 */
function searchDir(
  dir: string,
  query: string,
  workspaceRoot: string,
  maxResults: number,
  depth = 1,
): PathResult[] {
  if (!existsSync(dir) || depth < 1) return [];
  const results: PathResult[] = [];
  try {
    for (const entry of Deno.readDirSync(dir)) {
      if (results.length >= maxResults) break;
      if (!entry.isDirectory) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      if (entry.name === ".git") continue;
      const fullPath = join(dir, entry.name);
      if (score(entry.name, query) >= 0) {
        results.push({
          name: entry.name,
          path: fullPath,
          rel: relative(workspaceRoot, fullPath),
        });
      }
      if (depth > 1) {
        results.push(
          ...searchDir(
            fullPath,
            query,
            workspaceRoot,
            maxResults - results.length,
            depth - 1,
          ),
        );
      }
    }
  } catch {
    // Permission errors, etc.
  }
  return results;
}

/**
 * Search for directories matching the query across the workspace tree.
 * Priority order: repos/ first, then worktrees/, then any other top-level
 * children (nested sub-workspaces).
 */
function searchWorkspace(
  query: string,
  paths: ManifestPaths,
): PathResult[] {
  const all: PathResult[] = [];

  // 1. repos/ — the primary directory
  all.push(...searchDir(paths.repositoriesDirectory, query, paths.root, 50));

  // 2. worktrees/ — feature branches are two levels deep (repo/feature)
  all.push(...searchDir(paths.worktreesDirectory, query, paths.root, 20, 2));

  // 3. Top-level directories not in repos/worktrees/secrets
  //    (handles nested sub-workspaces that are directories, not manifests)
  if (existsSync(paths.root)) {
    const skip = new Set([
      "repos",
      "worktrees",
      "secrets",
      "node_modules",
      ".git",
    ]);
    try {
      for (const entry of Deno.readDirSync(paths.root)) {
        if (!entry.isDirectory || skip.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        all.push(
          ...searchDir(join(paths.root, entry.name), query, paths.root, 20),
        );
      }
    } catch {
      // Permission errors.
    }
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

export function run(
  opts: CliOptions,
  _manifest: WorkspaceManifest,
  paths: ManifestPaths,
): number {
  const query = opts.positional[0];
  if (!query) {
    console.error(
      "Usage: wspace path <query> [--json]",
    );
    return 2;
  }

  const raw = searchWorkspace(query, paths);
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
