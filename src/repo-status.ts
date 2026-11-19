import type { GitRunner } from "./git.ts";
import { branchAb, configuredUpstream, hasRef } from "./git.ts";
import type { RepositoryEntry, RepoState, RepoStatus } from "./types.ts";
import {
  type InspectOptions,
  inspectRepo,
  type RepoInspection,
} from "./repo-inspect.ts";

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
  inspectOpts: InspectOptions = {},
  inspection?: RepoInspection,
): Promise<RepoStatus> {
  const base = { name: repository.name, path: repoPath };
  // Callers that already inspected (e.g. the workspace root, whose git-ness
  // gates inclusion) pass the inspection through so it is computed once.
  inspection ??= await inspectRepo(g, repoPath, inspectOpts);

  if (!inspection.exists) {
    return { ...base, state: "MISSING" };
  }
  if (!inspection.isGit) {
    return {
      ...base,
      state: "INVALID",
      detail: "Path exists but is not a Git repository",
    };
  }

  try {
    const branch = inspection.branch;
    const defaultBr = inspection.defaultBranch;
    const dirty = inspection.dirty;
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
  } catch (err) {
    return {
      ...base,
      state: "ERROR",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
