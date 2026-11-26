import type { GitRunner } from "./git.ts";
import { diffQuiet, hasRef, revListCount, treeHash } from "./git.ts";

/** How a merge was proven, for the human-readable detail column. */
export interface Proof {
  detail: string;
}

/** What the remote (`gh`) proof tier needs beyond the local ladder. */
export interface RemoteProofOptions {
  /** A `gh` runner. When omitted the sweep is offline-only. */
  gh: GitRunner;
  /** The default branch a PR must have been merged into. */
  baseBranch: string;
  /** Fetch a PR head that is missing locally. Off for `--dry-run`. */
  fetchMissing: boolean;
}

/**
 * Prove that `branch`'s work is already contained in `baseline`.
 *
 * The ladder is cheapest-first. The offline tiers (tree equality, an empty
 * diff, ancestry) come first. They authorise cleanup of rebase merges, but a
 * squash merge leaves `main` moved on, so none of them can see it. Only when
 * all of them fail, and a `gh` runner is supplied, does the remote tier ask
 * GitHub whether the branch's PR was merged (see ADR-0006).
 */
export async function proveMerged(
  g: GitRunner,
  cwd: string,
  baseline: string,
  branch: string,
  remote?: RemoteProofOptions,
): Promise<Proof | undefined> {
  const baselineTree = await treeHash(g, cwd, baseline);
  const branchTree = await treeHash(g, cwd, branch);
  if (baselineTree !== undefined && baselineTree === branchTree) {
    return { detail: `trees identical (${baselineTree.slice(0, 7)})` };
  }
  if (await diffQuiet(g, cwd, baseline, branch)) {
    return { detail: `no diff against ${baseline}` };
  }
  const ahead = await revListCount(g, cwd, `${baseline}..${branch}`);
  if (ahead === 0) {
    return { detail: `contained in ${baseline}` };
  }
  if (remote && branchTree !== undefined) {
    return await provePullRequestMerged(g, cwd, branch, branchTree, remote);
  }
  return undefined;
}

interface PullRequest {
  number: number;
  headRefOid: string;
}

/** Parse `gh pr list --json number,headRefOid`, dropping malformed rows. */
function parsePullRequests(stdout: string): PullRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows: PullRequest[] = [];
  for (const item of parsed as unknown[]) {
    const row = item as Partial<PullRequest> | null;
    if (typeof row?.number === "number" && typeof row.headRefOid === "string") {
      rows.push({ number: row.number, headRefOid: row.headRefOid });
    }
  }
  return rows;
}

/** The tree of a PR head, fetching `refs/pull/<n>/head` once if it is absent. */
async function pullRequestTree(
  g: GitRunner,
  cwd: string,
  pr: PullRequest,
  fetchMissing: boolean,
): Promise<string | undefined> {
  const tree = await treeHash(g, cwd, pr.headRefOid);
  if (tree !== undefined || !fetchMissing) return tree;
  await g.run(["fetch", "origin", `refs/pull/${pr.number}/head`], cwd);
  return await treeHash(g, cwd, pr.headRefOid);
}

/**
 * Remote tier: a merged PR into the default branch whose head is the branch tip
 * (same SHA) or whose head tree equals the branch tree. A tip that has moved
 * past the PR head with new content matches neither, so post-merge work is
 * never swept. Any `gh` failure (not installed, not authenticated, offline)
 * yields no proof, which leaves the ladder's offline result unchanged.
 */
async function provePullRequestMerged(
  g: GitRunner,
  cwd: string,
  branch: string,
  branchTree: string,
  { gh, baseBranch, fetchMissing }: RemoteProofOptions,
): Promise<Proof | undefined> {
  let listed;
  try {
    listed = await gh.run(
      [
        "pr",
        "list",
        "--head",
        branch,
        "--base",
        baseBranch,
        "--state",
        "merged",
        "--json",
        "number,headRefOid",
        "--limit",
        "30",
      ],
      cwd,
    );
  } catch {
    return undefined;
  }
  if (listed.code !== 0) return undefined;

  const tip = (await g.run(["rev-parse", "--verify", "--quiet", branch], cwd))
    .stdout;
  for (const pr of parsePullRequests(listed.stdout)) {
    if (pr.headRefOid === tip) {
      return { detail: `PR #${pr.number} merged, tip == PR head` };
    }
    if ((await pullRequestTree(g, cwd, pr, fetchMissing)) === branchTree) {
      return { detail: `PR #${pr.number} merged, tip tree == PR head` };
    }
  }
  return undefined;
}

/**
 * Choose the baseline a merge is proven against.
 *
 * This is load-bearing. Right after a merge the canonical checkout is usually
 * still behind `origin/<default>`, so proving against the local default ref
 * would refuse cleanup in exactly the case the command exists for.
 */
export async function resolveBaseline(
  g: GitRunner,
  cwd: string,
  defaultBranchName: string,
): Promise<string> {
  const remote = `origin/${defaultBranchName}`;
  return (await hasRef(g, cwd, `refs/remotes/${remote}`))
    ? remote
    : defaultBranchName;
}
