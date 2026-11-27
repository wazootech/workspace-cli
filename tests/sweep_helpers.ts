import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "@std/path";
import { SystemGit } from "@/git.ts";

export const g = new SystemGit();

export async function configure(dir: string): Promise<void> {
  await g.run(["config", "user.email", "wspace-test@example.com"], dir);
  await g.run(["config", "user.name", "WSC Test"], dir);
  await g.run(["config", "commit.gpgsign", "false"], dir);
}

/**
 * Build a repo with a bare origin, a seed checkout on `main`, and a clone at
 * `<dir>/<name>` whose origin/HEAD points at main. Returns the clone path.
 */
export async function makeRepoWithMain(
  dir: string,
  name: string,
): Promise<string> {
  const origin = join(dir, `${name}.git`);
  const seed = join(dir, `${name}-seed`);
  assert((await g.run(["init", "--bare", origin])).code === 0, "init bare");
  assert((await g.run(["init", seed])).code === 0, "init seed");
  await configure(seed);
  assert((await g.run(["checkout", "-b", "main"], seed)).code === 0);
  await writeFile(join(seed, "a.txt"), "one\n");
  await g.run(["add", "."], seed);
  assert((await g.run(["commit", "-m", "seed"], seed)).code === 0);
  assert((await g.run(["push", origin, "main"], seed)).code === 0);
  assert(
    (await g.run(["symbolic-ref", "HEAD", "refs/heads/main"], origin)).code ===
      0,
    "set origin HEAD",
  );
  const work = join(dir, name);
  assert((await g.run(["clone", origin, work])).code === 0, "clone");
  await configure(work);
  return work;
}

/** Add a linked worktree on a new branch at `<dir>/wt-<branch>`. */
export async function addWorktree(
  work: string,
  dir: string,
  branch: string,
): Promise<string> {
  const wt = join(dir, `wt-${branch.replaceAll("/", "-")}`);
  assert(
    (await g.run(["worktree", "add", "-b", branch, wt], work)).code === 0,
    `add worktree ${branch}`,
  );
  await configure(wt);
  return wt;
}

/**
 * Land the worktree's commit on main through the seed repo the way a rebase
 * merge does: the same tree, a different SHA. `git branch -d` refuses this,
 * so only tree equality can authorise cleanup.
 */
export async function rebaseMerge(
  dir: string,
  name: string,
  content: string,
): Promise<void> {
  const seed = join(dir, `${name}-seed`);
  await writeFile(join(seed, "a.txt"), content);
  await g.run(["add", "."], seed);
  assert((await g.run(["commit", "-m", "rebase merge"], seed)).code === 0);
  assert(
    (await g.run(["push", join(dir, `${name}.git`), "main"], seed)).code === 0,
  );
}

export function pathsFor(dir: string) {
  return { root: dir, repositoriesDirectory: dir };
}

/**
 * Git prints worktree paths with forward slashes on Windows while @std/path
 * produces backslashes; compare in one form.
 */
export function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

export async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rm(dir, { recursive: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}
