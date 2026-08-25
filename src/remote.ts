import type { GitRunner } from "./git.ts";

export type RemoteProbeStatus = "found" | "missing" | "error";

export interface RemoteProbeResult {
  status: RemoteProbeStatus;
  stderr?: string;
}

const MISSING_PATTERNS = [
  /could not resolve/i,
  /not found/i,
  /\b404\b/,
];

/**
 * Probe whether a GitHub repository exists. Only the not-found shape of
 * failure is classified as "missing"; auth or network problems surface as
 * "error" so callers can fail closed instead of creating duplicates.
 */
export async function probeGitHubRepo(
  gh: GitRunner,
  slug: string,
): Promise<RemoteProbeResult> {
  const result = await gh.run(["repo", "view", slug]);
  if (result.code === 0) return { status: "found" };
  const stderr = result.stderr || result.stdout;
  if (MISSING_PATTERNS.some((p) => p.test(stderr))) {
    return { status: "missing", stderr };
  }
  return { status: "error", stderr };
}

/**
 * Create a GitHub repository under `slug` with the given visibility.
 */
export async function createGitHubRepo(
  gh: GitRunner,
  slug: string,
  visibility: "public" | "private",
): Promise<{ ok: boolean; stderr?: string }> {
  const result = await gh.run([
    "repo",
    "create",
    slug,
    `--${visibility}`,
  ]);
  if (result.code === 0) return { ok: true };
  return { ok: false, stderr: result.stderr || result.stdout };
}
