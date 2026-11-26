import { join, normalize, resolve, SEPARATOR } from "@std/path";
import { type ManifestPaths, resolveRepositoryPath } from "./manifest-paths.ts";
import { pathExists, readDirectory } from "./runtime.ts";
import type { RepositoryEntry, RepoStatus } from "./types.ts";

/** Entries that sit beside checkouts by convention and are never strays. */
const IGNORED_ENTRIES = new Set(
  ".git .gitkeep .gitignore .DS_Store Thumbs.db".split(" "),
);

/** Workspace-root directories that hold harness content, not strays. */
const ROOT_DIRECTORIES = new Set(
  "repos workspaces worktrees secrets tmp node_modules".split(" "),
);

/** Builds the status row for an unmanaged git checkout. */
export type CheckoutRow = (name: string, path: string) => Promise<RepoStatus>;

interface Known {
  names: Set<string>;
  paths: string[];
}

export function isInside(parent: string, child: string): boolean {
  return child.startsWith(parent + SEPARATOR);
}

function stray(name: string, path: string, detail: string): RepoStatus {
  return { name, path, state: "UNMANAGED", detail, unmanaged: true };
}

async function scanDirectory(
  dir: string,
  known: Known,
  checkout: CheckoutRow,
): Promise<RepoStatus[]> {
  if (!(await pathExists(dir))) return [];
  const rows: RepoStatus[] = [];
  for (const entry of await readDirectory(dir)) {
    const path = normalize(resolve(dir, entry.name));
    const label = `(unmanaged) ${entry.name}`;
    if (IGNORED_ENTRIES.has(entry.name) || known.names.has(entry.name)) {
      continue;
    }
    // A directory that holds declared checkouts is a container, not a stray.
    if (known.paths.some((p) => p === path || isInside(path, p))) continue;
    if (!entry.isDirectory) {
      rows.push(stray(label, path, "stray file"));
    } else if (await pathExists(join(path, ".git"))) {
      rows.push({ ...(await checkout(label, path)), unmanaged: true });
    } else {
      const empty = (await readDirectory(path)).length === 0;
      rows.push(
        stray(
          label,
          path,
          `${empty ? "empty directory" : "directory"}, not a Git checkout`,
        ),
      );
    }
  }
  return rows;
}

async function scanRoot(
  paths: ManifestPaths,
  known: Known,
  configured: string[],
): Promise<RepoStatus[]> {
  const rows: RepoStatus[] = [];
  for (const entry of await readDirectory(paths.root)) {
    if (!entry.isDirectory || entry.name.startsWith(".")) continue;
    if (ROOT_DIRECTORIES.has(entry.name)) continue;
    const path = normalize(resolve(paths.root, entry.name));
    const claimed = [...configured, ...known.paths];
    if (claimed.some((p) => p === path || isInside(path, p))) continue;
    if (!(await pathExists(join(path, ".git")))) continue;
    rows.push(
      stray(
        `(stray) ${entry.name}`,
        path,
        known.names.has(entry.name)
          ? `unmanaged duplicate of registered repo "${entry.name}"`
          : "unmanaged Git checkout at the workspace root",
      ),
    );
  }
  return rows;
}

/**
 * Find things on disk that no manifest declares: unmanaged checkouts, plain
 * directories, and files under the repositories and workspaces directories,
 * plus Git checkouts dropped at the workspace root (the signature of a bulk
 * clone run from the wrong directory). Rows are `UNMANAGED` warnings.
 */
export async function scanStrays(
  repositories: RepositoryEntry[],
  paths: ManifestPaths,
  checkout: CheckoutRow,
  includeRoot: boolean,
): Promise<RepoStatus[]> {
  const known: Known = {
    names: new Set(repositories.map((r) => r.name)),
    paths: repositories.map((r) => normalize(resolveRepositoryPath(r, paths))),
  };
  const configured = [paths.repositoriesDirectory];
  if (paths.workspacesDirectory !== undefined) {
    configured.push(paths.workspacesDirectory);
  }
  const dirs = [...new Set(configured.map((d) => normalize(d)))];
  const rows: RepoStatus[] = [];
  for (const dir of dirs) {
    rows.push(...(await scanDirectory(dir, known, checkout)));
  }
  // When the root is itself a scanned directory its entries are already covered.
  if (includeRoot && !dirs.includes(normalize(paths.root))) {
    rows.push(...(await scanRoot(paths, known, dirs)));
  }
  return rows;
}

/**
 * Rows warning that a repository `install` is about to place already exists
 * as a Git checkout directly under the workspace root, outside its declared
 * path (the duplicate left by a bulk clone from the wrong directory).
 */
export async function rootStrayRows(
  repositories: RepositoryEntry[],
  paths: ManifestPaths,
): Promise<{ name: string; state: string; detail: string }[]> {
  const rows = [];
  for (const repository of repositories) {
    if (ROOT_DIRECTORIES.has(repository.name)) continue;
    const rootPath = normalize(resolve(paths.root, repository.name));
    if (rootPath === normalize(resolveRepositoryPath(repository, paths))) {
      continue;
    }
    if (await pathExists(join(rootPath, ".git"))) {
      rows.push({
        name: `(stray) ${repository.name}`,
        state: "UNMANAGED",
        detail: `unmanaged duplicate of registered repo "${repository.name}" at ${rootPath}`,
      });
    }
  }
  return rows;
}
