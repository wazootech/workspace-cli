import { basename, join, resolve } from "@std/path";
import type { GitRunner } from "./git.ts";
import { currentBranch, defaultBranch, isDirty } from "./git.ts";

export const FACTORY_VERSION = "1.0.0";
const MANIFEST_VERSION = 1;
const MANAGED_FILES = [".wazoo/factory.json", ".wazoo/README.md"];
const METADATA_FILES = [
  "package.json",
  "deno.json",
  "pyproject.toml",
  "Cargo.toml",
];
const CONFIG_FILES = ["opencode.json", ".codex/config.toml", ".claude"];
const PREFERRED_COMMANDS = [
  "format:check",
  "typecheck",
  "test",
  "build",
  "health",
  "test:e2e",
  "smoke",
];

export interface FactoryManifest {
  factoryVersion: string;
  manifestVersion: number;
  repository: {
    identity: string;
    root: string;
    defaultBranch: string;
  };
  workflow: {
    mode: "light";
    smoke: "read-only";
  };
  commands: string[];
  checks: {
    health: string[];
    smoke: string[];
  };
  protectedPaths: string[];
  definitionOfDone: string[];
}

export interface FactoryDiscovery {
  root: string;
  identity: string;
  defaultBranch: string;
  dirty: boolean;
  inspections: {
    agents: boolean;
    workflows: string[];
    metadata: string[];
    agentConfig: string[];
  };
  commands: string[];
}

export interface BootstrapResult {
  root: string;
  discovery: FactoryDiscovery;
  manifest: FactoryManifest;
  actions: {
    path: string;
    action: "create" | "change" | "unchanged" | "conflict";
  }[];
  dryRun: boolean;
}

export function validateFactoryManifest(
  value: unknown,
): asserts value is FactoryManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Factory manifest must be an object");
  }
  const manifest = value as Partial<FactoryManifest>;
  if (
    typeof manifest.factoryVersion !== "string" ||
    manifest.factoryVersion !== FACTORY_VERSION
  ) {
    throw new Error("Unsupported or missing factoryVersion");
  }
  if (
    typeof manifest.manifestVersion !== "number" ||
    manifest.manifestVersion !== MANIFEST_VERSION
  ) {
    throw new Error("Unsupported or missing manifestVersion");
  }
  if (
    !manifest.repository || typeof manifest.repository !== "object" ||
    Array.isArray(manifest.repository)
  ) {
    throw new Error("Factory manifest requires repository");
  }
  if (
    typeof manifest.repository.identity !== "string" ||
    !manifest.repository.identity ||
    typeof manifest.repository.root !== "string" || !manifest.repository.root ||
    typeof manifest.repository.defaultBranch !== "string" ||
    !manifest.repository.defaultBranch
  ) {
    throw new Error(
      "Factory repository requires identity, root, and defaultBranch",
    );
  }
  if (
    !manifest.workflow || typeof manifest.workflow !== "object" ||
    Array.isArray(manifest.workflow) ||
    manifest.workflow.mode !== "light" ||
    manifest.workflow.smoke !== "read-only"
  ) throw new Error("Factory workflow must be light and read-only");
  if (
    !stringArray(manifest.commands) ||
    !manifest.checks || typeof manifest.checks !== "object" ||
    Array.isArray(manifest.checks) ||
    !stringArray(manifest.checks.health) ||
    !stringArray(manifest.checks.smoke) ||
    !stringArray(manifest.protectedPaths) ||
    !stringArray(manifest.definitionOfDone)
  ) {
    throw new Error(
      "Factory manifest requires command, checks, protectedPaths, and definitionOfDone arrays",
    );
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0);
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function rejectSymlink(path: string, label: string): Promise<void> {
  try {
    const info = await Deno.lstat(path);
    if (info.isSymlink) throw new Error(`Refusing symlinked ${label}: ${path}`);
    if (label === ".wazoo directory" && !info.isDirectory) {
      throw new Error(`Expected .wazoo to be a directory: ${path}`);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

async function checkWazooSafety(root: string): Promise<void> {
  await rejectSymlink(join(root, ".wazoo"), ".wazoo directory");
  for (const file of MANAGED_FILES) {
    await rejectSymlink(join(root, file), `managed file ${file}`);
  }
}

async function repositoryRoot(g: GitRunner, target: string): Promise<string> {
  const result = await g.run(["rev-parse", "--show-toplevel"], target);
  if (result.code !== 0 || !result.stdout) {
    throw new Error(
      `Not a Git repository: ${target}. Run this command inside a Git checkout or pass its path.`,
    );
  }
  return resolve(result.stdout);
}

async function repositoryIdentity(g: GitRunner, root: string): Promise<string> {
  const result = await g.run(["config", "--get", "remote.origin.url"], root);
  if (result.code === 0 && result.stdout) {
    const value = result.stdout.replace(/[\\/]$/, "").split(/[\\/]/).pop() ??
      "";
    const identity = value.replace(/\.git$/, "");
    if (identity) return identity;
  }
  return basename(root);
}

async function statusPaths(g: GitRunner, root: string): Promise<string[]> {
  const result = await g.run(["status", "--porcelain"], root);
  if (result.code !== 0) {
    throw new Error(
      `Unable to inspect Git status for ${root}: ${result.stderr}`,
    );
  }
  return result.stdout.split("\n").filter(Boolean).flatMap((line) => {
    const value = line.slice(3);
    return value.includes(" -> ") ? value.split(" -> ") : [value];
  });
}

function isWazooPath(path: string): boolean {
  return path === ".wazoo" || path.startsWith(".wazoo/") ||
    path.startsWith(".wazoo\\");
}

function checkLists(commands: string[]): FactoryManifest["checks"] {
  return {
    health: commands.filter((command) => command.startsWith("health:")),
    smoke: commands.filter((command) => command === "smoke"),
  };
}

async function discoverCommands(
  root: string,
  files: string[],
): Promise<string[]> {
  const commands = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(
        await Deno.readTextFile(join(root, file)),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("metadata must be a JSON object");
      }
      data = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Invalid ${file} metadata: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const scripts = data.scripts ?? data.tasks;
    if (
      scripts !== undefined &&
      (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
    ) {
      throw new Error(
        `Invalid ${file} metadata: scripts/tasks must be an object`,
      );
    }
    if (scripts && typeof scripts === "object") {
      for (const name of Object.keys(scripts)) {
        if (PREFERRED_COMMANDS.includes(name) || name.startsWith("health:")) {
          commands.add(name);
        }
      }
    }
  }
  if (files.includes("pyproject.toml")) commands.add("test");
  if (files.includes("Cargo.toml")) commands.add("test");
  const rank = (name: string) => {
    const exact = PREFERRED_COMMANDS.indexOf(name);
    return exact >= 0 ? exact : name.startsWith("health:") ? 4 : 99;
  };
  return [...commands].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

async function listWorkflows(root: string): Promise<string[]> {
  const directory = join(root, ".github", "workflows");
  try {
    return (await Array.fromAsync(Deno.readDir(directory))).map((entry) =>
      entry.name
    ).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).sort();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

export async function discoverFactory(
  g: GitRunner,
  target: string,
): Promise<FactoryDiscovery> {
  if (!(await directoryExists(target))) {
    throw new Error(
      `Not a Git repository: ${target}. Run this command inside a Git checkout or pass its path.`,
    );
  }
  const root = await repositoryRoot(g, target);
  await checkWazooSafety(root);
  const metadata = [] as string[];
  for (const file of METADATA_FILES) {
    if (await fileExists(join(root, file))) metadata.push(file);
  }
  const agentConfig = [] as string[];
  for (const file of CONFIG_FILES) {
    if (await fileExists(join(root, file))) agentConfig.push(file);
  }
  return {
    root,
    identity: await repositoryIdentity(g, root),
    defaultBranch: await defaultBranch(g, root) ??
      ((await g.run(["config", "--get", "remote.origin.url"], root)).stdout
        ? (() => {
          throw new Error(
            "Cannot determine default branch: origin/HEAD is unavailable; configure origin/HEAD or remove the remote for a local fixture.",
          );
        })()
        : await currentBranch(g, root) ?? "unknown"),
    dirty: await isDirty(g, root),
    inspections: {
      agents: await fileExists(join(root, "AGENTS.md")),
      workflows: await listWorkflows(root),
      metadata,
      agentConfig,
    },
    commands: await discoverCommands(root, metadata),
  };
}

function makeManifest(discovery: FactoryDiscovery): FactoryManifest {
  const manifest: FactoryManifest = {
    factoryVersion: FACTORY_VERSION,
    manifestVersion: MANIFEST_VERSION,
    repository: {
      identity: discovery.identity,
      root: ".",
      defaultBranch: discovery.defaultBranch,
    },
    workflow: { mode: "light", smoke: "read-only" },
    commands: discovery.commands,
    checks: checkLists(discovery.commands),
    protectedPaths: [
      ".github/workflows",
      "migrations",
      "schema",
      "auth",
      "deploy",
      ".env",
      ".env.*",
      ".dev.vars",
      ".dev.vars.*",
    ],
    definitionOfDone: [
      "format:check passes",
      "typecheck passes",
      "tests pass",
      "QA precedes explicit production approval",
    ],
  };
  return manifest;
}

function factoryReadme(manifest: FactoryManifest): string {
  return `# Wazoo factory metadata\n\nThis directory is factory-managed. The repository owns its code; this CLI records only safe, light workflow metadata.\n\n- Bootstrap: \`wspace factory bootstrap .\`\n- Read-only smoke: \`wspace factory smoke .\`\n- Smoke never runs scripts, writes files, commits, pushes, deploys, or merges.\n- \`checks.health\` records repository-local health checks; \`checks.smoke\` records discovered smoke commands. Workspace-level policy decides whether a discovered \`smoke\` command is a QA gate.\n- Secrets belong in the workspace secrets vault and env sync.\n- Worktree and unrelated-dirty changes are never overwritten.\n- Workspace-level policy owns platform architecture and repository coordination.\n\nFactory version: \`${manifest.factoryVersion}\`\n`;
}

export async function bootstrapFactory(
  g: GitRunner,
  target: string,
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<BootstrapResult> {
  const discovery = await discoverFactory(g, target);
  const manifest = makeManifest(discovery);
  validateFactoryManifest(manifest);
  const files = new Map<string, string>([[
    MANAGED_FILES[0],
    stableJson(manifest),
  ], [MANAGED_FILES[1], factoryReadme(manifest)]]);
  const actions: BootstrapResult["actions"] = [];
  for (const [relative, content] of files) {
    const path = join(discovery.root, relative);
    if (!(await fileExists(path))) {
      actions.push({ path: relative, action: "create" });
    } else if (await Deno.readTextFile(path) === content) {
      actions.push({ path: relative, action: "unchanged" });
    } else if (options.force) {
      actions.push({ path: relative, action: "change" });
    } else actions.push({ path: relative, action: "conflict" });
  }
  if (!options.dryRun) {
    const unrelated = (await statusPaths(g, discovery.root)).filter((path) =>
      !isWazooPath(path)
    );
    if (unrelated.length > 0) {
      throw new Error(
        `Refusing bootstrap: unrelated Git changes are present (${
          unrelated.join(", ")
        }). Commit or stash them, then retry; --force does not bypass this check.`,
      );
    }
    if (actions.some((action) => action.action === "conflict")) {
      throw new Error(
        "Factory-managed files conflict; re-run with --force to overwrite only .wazoo-managed files.",
      );
    }
    await checkWazooSafety(discovery.root);
    await Deno.mkdir(join(discovery.root, ".wazoo"), { recursive: true });
    for (const [relative, content] of files) {
      if (actions.find((a) => a.path === relative)?.action !== "unchanged") {
        await checkWazooSafety(discovery.root);
        await rejectSymlink(
          join(discovery.root, relative),
          `managed file ${relative}`,
        );
        await Deno.writeTextFile(join(discovery.root, relative), content);
      }
    }
  }
  return {
    root: discovery.root,
    discovery,
    manifest,
    actions,
    dryRun: options.dryRun ?? false,
  };
}

export async function smokeFactory(
  g: GitRunner,
  target: string,
): Promise<
  {
    valid: boolean;
    root: string;
    identity: string;
    defaultBranch: string;
    dirty: boolean;
    commands: string[];
    protectedPaths: string[];
    manifest?: FactoryManifest;
    error?: string;
  }
> {
  let discovery: FactoryDiscovery;
  try {
    discovery = await discoverFactory(g, target);
  } catch (error) {
    const root = resolve(target);
    return {
      valid: false,
      root,
      identity: basename(root),
      defaultBranch: "unknown",
      dirty: false,
      commands: [],
      protectedPaths: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const path = join(discovery.root, ".wazoo", "factory.json");
  try {
    const manifest = JSON.parse(await Deno.readTextFile(path));
    validateFactoryManifest(manifest);
    if (resolve(discovery.root, manifest.repository.root) !== discovery.root) {
      throw new Error("manifest repository root does not match Git root");
    }
    if (manifest.repository.identity !== discovery.identity) {
      throw new Error("manifest repository identity does not match origin");
    }
    if (manifest.repository.defaultBranch !== discovery.defaultBranch) {
      throw new Error("manifest default branch does not match Git");
    }
    return {
      valid: true,
      root: discovery.root,
      identity: discovery.identity,
      defaultBranch: discovery.defaultBranch,
      dirty: discovery.dirty,
      commands: manifest.commands,
      protectedPaths: manifest.protectedPaths,
      manifest,
    };
  } catch (error) {
    return {
      valid: false,
      root: discovery.root,
      identity: discovery.identity,
      defaultBranch: discovery.defaultBranch,
      dirty: discovery.dirty,
      commands: discovery.commands,
      protectedPaths: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
