export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(args: string[], cwd?: string): Promise<GitResult>;
}

export class SystemGit implements GitRunner {
  constructor(private readonly git: string = "git") {}

  async run(args: string[], cwd?: string): Promise<GitResult> {
    const command = new Deno.Command(this.git, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    const decoder = new TextDecoder();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout).trim(),
      stderr: decoder.decode(output.stderr).trim(),
    };
  }
}

export async function currentBranch(
  g: GitRunner,
  cwd: string,
): Promise<string | undefined> {
  const result = await g.run(["branch", "--show-current"], cwd);
  return result.code === 0 && result.stdout ? result.stdout : undefined;
}

export async function defaultBranch(
  g: GitRunner,
  cwd: string,
): Promise<string | undefined> {
  const result = await g.run(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    cwd,
  );
  if (result.code === 0 && result.stdout) {
    return result.stdout.replace(/^origin\//, "");
  }
  for (const candidate of ["main", "master"]) {
    const probe = await g.run(
      ["rev-parse", "--verify", `refs/remotes/origin/${candidate}`],
      cwd,
    );
    if (probe.code === 0) {
      return candidate;
    }
  }
  return undefined;
}

export async function isDirty(g: GitRunner, cwd: string): Promise<boolean> {
  const result = await g.run(["status", "--porcelain"], cwd);
  return result.code === 0 && result.stdout.length > 0;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export async function branchAb(
  g: GitRunner,
  cwd: string,
  upstream: string,
): Promise<AheadBehind | undefined> {
  const porcelain = await g.run(["status", "--porcelain=v2", "--branch"], cwd);
  if (porcelain.code === 0) {
    for (const line of porcelain.stdout.split("\n")) {
      const match = line.trim().match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        return { ahead: Number(match[1]), behind: Number(match[2]) };
      }
    }
  }
  const count = await g.run(
    ["rev-list", "--left-right", "--count", `HEAD...${upstream}`],
    cwd,
  );
  if (count.code !== 0 || !count.stdout) {
    return undefined;
  }
  const [ahead, behind] = count.stdout.split(/\s+/).map(Number);
  return { ahead, behind };
}

export async function configuredUpstream(
  g: GitRunner,
  cwd: string,
  branch: string,
): Promise<string | undefined> {
  const remote =
    (await g.run(["config", "--get", `branch.${branch}.remote`], cwd))
      .stdout;
  const merge =
    (await g.run(["config", "--get", `branch.${branch}.merge`], cwd))
      .stdout;
  return remote && merge
    ? `${remote}/${merge.replace(/^refs\/heads\//, "")}`
    : undefined;
}

export async function hasRef(
  g: GitRunner,
  cwd: string,
  ref: string,
): Promise<boolean> {
  const result = await g.run(["show-ref", "--verify", "--quiet", ref], cwd);
  return result.code === 0;
}

export async function hasDefaultBranchWorktree(
  g: GitRunner,
  cwd: string,
  defaultBranchName: string,
): Promise<boolean> {
  const result = await g.run(["worktree", "list", "--porcelain"], cwd);
  if (result.code !== 0) return false;
  return result.stdout.split("\n").some((line) =>
    line === `branch refs/heads/${defaultBranchName}`
  );
}

export async function fetch(g: GitRunner, cwd: string): Promise<boolean> {
  return (await g.run(["fetch", "--prune"], cwd)).code === 0;
}

export async function fastForwardMerge(
  g: GitRunner,
  cwd: string,
  ref: string,
): Promise<boolean> {
  return (await g.run(["merge", "--ff-only", ref], cwd)).code === 0;
}

export async function clone(
  g: GitRunner,
  url: string,
  dir: string,
): Promise<GitResult> {
  return await g.run(["clone", url, dir]);
}
