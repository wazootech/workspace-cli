import type { GitRunner } from "./git.ts";
import { branchAb, fastForwardMerge, fetch } from "./git.ts";
import { type ManifestPaths, resolveRepositoryPath } from "./manifest-paths.ts";
import type { RepositoryEntry, UpdateAction } from "./types.ts";
import { inspectRepo } from "./repo-inspect.ts";

export async function planUpdate(
  g: GitRunner,
  repositories: RepositoryEntry[],
  paths: ManifestPaths,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<UpdateAction[]> {
  const actions: UpdateAction[] = [];
  for (const repository of repositories) {
    const repoPath = resolveRepositoryPath(repository, paths);
    const inspection = await inspectRepo(g, repoPath);

    if (!inspection.exists) {
      actions.push({ kind: "MISSING", name: repository.name });
      continue;
    }
    if (!inspection.isGit) {
      actions.push({ kind: "INVALID", name: repository.name });
      continue;
    }

    const branch = inspection.branch;
    const defaultBranchName = inspection.defaultBranch;
    const dirty = inspection.dirty;

    if (dirty) {
      actions.push({
        kind: "SKIP_DIRTY",
        name: repository.name,
        detail: "uncommitted changes",
      });
      continue;
    }
    if (branch && branch !== defaultBranchName) {
      actions.push({
        kind: "SKIP_FEATURE",
        name: repository.name,
        detail: `${branch} != ${defaultBranchName}`,
      });
      continue;
    }
    if (!defaultBranchName) {
      actions.push({
        kind: "SKIP_NO_DEFAULT",
        name: repository.name,
        detail: "no origin/HEAD",
      });
      continue;
    }

    // Dry-run: skip network calls (fetch) and mutations (merge).
    if (dryRun) {
      actions.push({
        kind: "WOULD_FAST_FORWARD",
        name: repository.name,
        detail: `origin/${defaultBranchName}`,
      });
      continue;
    }

    if (!(await fetch(g, repoPath))) {
      actions.push({ kind: "FETCH_FAILED", name: repository.name });
      continue;
    }

    const upstream = `origin/${defaultBranchName}`;
    const ab = await branchAb(g, repoPath, upstream);
    if (!ab) {
      actions.push({
        kind: "SKIP_NO_DEFAULT",
        name: repository.name,
        detail: "upstream tracking ref missing",
      });
      continue;
    }
    if (ab.ahead > 0) {
      actions.push({
        kind: "SKIP_AHEAD",
        name: repository.name,
        detail: `${ab.ahead} ahead, ${ab.behind} behind`,
      });
      continue;
    }
    if (ab.behind === 0) {
      actions.push({
        kind: "CURRENT",
        name: repository.name,
        detail: upstream,
      });
      continue;
    }

    const ok = await fastForwardMerge(g, repoPath, upstream);
    actions.push(
      ok
        ? { kind: "FAST_FORWARD", name: repository.name, commits: ab.behind }
        : {
          kind: "FAST_FORWARD_FAILED",
          name: repository.name,
          detail: upstream,
        },
    );
  }
  return actions;
}

export async function runUpdate(
  g: GitRunner,
  manifest: { repositories: RepositoryEntry[] },
  paths: ManifestPaths,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<UpdateAction[]> {
  return await planUpdate(g, manifest.repositories, paths, { dryRun });
}
