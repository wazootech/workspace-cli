import { join } from "@std/path";
import type { GitRunner } from "./git.ts";
import {
  branchAb,
  configuredUpstream,
  currentBranch,
  defaultBranch,
  hasRef,
  isDirty,
} from "./git.ts";
import { exists, resolveRepositoryPath } from "./manifest.ts";
import type { ManifestPaths } from "./manifest.ts";
import type { RepositoryEntry, RepoState, RepoStatus } from "./types.ts";

export interface ClassifyInput {
  dirty: boolean;
  featureBranch: boolean;
  hasDefaultBranch: boolean;
  upstream?: string;
  upstreamRefExists?: boolean;
  aheadBehind?: { ahead: number; behind: number };
}

export function classifyState(input: ClassifyInput): {
  state: RepoState;
  detail?: string;
} {
  if (input.dirty) {
    return { state: "DIRTY" };
  }
  if (input.featureBranch) {
    return { state: "FEATURE_CLEAN" };
  }
  if (!input.hasDefaultBranch) {
    return { state: "UNKNOWN", detail: "no origin/HEAD" };
  }
  if (!input.upstream) {
    return { state: "UNKNOWN", detail: "no upstream configured" };
  }
  if (!input.upstreamRefExists) {
    return { state: "UNKNOWN", detail: "missing tracking ref" };
  }
  if (!input.aheadBehind) {
    return { state: "UNKNOWN", detail: "ahead/behind unavailable" };
  }
  if (input.aheadBehind.ahead > 0 || input.aheadBehind.behind > 0) {
    return {
      state: "DIVERGED",
      detail:
        `${input.aheadBehind.ahead} ahead, ${input.aheadBehind.behind} behind`,
    };
  }
  return { state: "CLEAN" };
}

export async function repoStatus(
  g: GitRunner,
  repository: RepositoryEntry,
  repoPath: string,
): Promise<RepoStatus> {
  const base = { name: repository.name, path: repoPath };
  if (!(await exists(repoPath))) {
    return { ...base, state: "MISSING" };
  }
  if (!(await exists(join(repoPath, ".git")))) {
    return { ...base, state: "INVALID" };
  }

  const branch = await currentBranch(g, repoPath);
  const defaultBr = await defaultBranch(g, repoPath);
  const dirty = await isDirty(g, repoPath);
  const upstream = branch
    ? await configuredUpstream(g, repoPath, branch)
    : undefined;
  const featureBranch = branch !== undefined && branch !== defaultBr;

  let ahead: number | undefined;
  let behind: number | undefined;
  let upstreamRefExists: boolean | undefined;
  if (upstream && branch) {
    upstreamRefExists = await hasRef(g, repoPath, `refs/remotes/${upstream}`);
    if (upstreamRefExists) {
      const ab = await branchAb(g, repoPath, upstream);
      if (ab) {
        ahead = ab.ahead;
        behind = ab.behind;
      }
    }
  }

  const classified = classifyState({
    dirty,
    featureBranch,
    hasDefaultBranch: defaultBr !== undefined,
    upstream,
    upstreamRefExists,
    aheadBehind: ahead !== undefined
      ? { ahead, behind: behind ?? 0 }
      : undefined,
  });

  return {
    ...base,
    branch,
    defaultBranch: defaultBr,
    upstream,
    ahead,
    behind,
    state: classified.state,
    detail: classified.detail,
  };
}

export async function collectStatus(
  g: GitRunner,
  manifest: { repositories: RepositoryEntry[] },
  paths: ManifestPaths,
): Promise<RepoStatus[]> {
  const rows: RepoStatus[] = [];
  const managed = new Set(manifest.repositories.map((r) => r.name));
  const reposDir = paths.repositoriesDirectory;

  if (await exists(reposDir)) {
    for await (const entry of Deno.readDir(reposDir)) {
      if (!entry.isDirectory || entry.name === ".git") {
        continue;
      }
      const candidatePath = join(reposDir, entry.name);
      if (await exists(join(candidatePath, ".git"))) {
        rows.push(
          await repoStatus(
            g,
            { name: `(unmanaged) ${entry.name}`, url: "" },
            candidatePath,
          ),
        );
      }
    }
  }

  for (const repository of manifest.repositories) {
    const repoPath = resolveRepositoryPath(repository, paths);
    if (!managed.has(repository.name)) {
      continue;
    }
    rows.push(await repoStatus(g, repository, repoPath));
  }
  return rows;
}

export function hasErrors(statuses: RepoStatus[]): boolean {
  return statuses.some(
    (s) => s.state !== "CLEAN" && s.state !== "FEATURE_CLEAN",
  );
}
