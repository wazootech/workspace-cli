/**
 * Runtime edge — the one module in `src/` that touches the host runtime.
 *
 * `wspace` runs two ways: on Deno (as a compiled binary or via `deno run`) and
 * on Node (via the JSR npm-compatibility package). Two host interfaces do not
 * exist on Node, so both are owned here:
 *
 *  - Deno's `Deno.*` globals, replaced with `node:` builtins; Deno implements
 *    the `node:` specifiers natively, so one implementation serves both
 *    runtimes;
 *  - `@std/fs`, which is Deno-only. Its `exists` and `walk` call the `Deno`
 *    global directly — in the TypeScript source *and* in the JavaScript JSR
 *    ships to npm — so importing it type-checks and tests clean on Deno while
 *    throwing `ReferenceError: Deno is not defined` on Node. The two call
 *    shapes this CLI needs live here instead, as {@link pathExists} and
 *    {@link walkDirectoryTree}.
 *
 * Nothing else in `src/` may import `node:*` or `@std/fs`. `@std/path` and
 * `@std/cli` are runtime-neutral and stay in use.
 *
 * Two host details genuinely differ and must not be hand-normalised:
 *
 *  - the OS name is `"windows"` on `Deno.build.os` and `"win32"` on
 *    `process.platform`, so platform checks go through {@link isWindows};
 *  - `Deno.args` has no Node equivalent, and `process.argv` is shaped
 *    `[runtime, scriptOrBinary, ...args]` on all of `deno run`, a compiled
 *    binary, and `node <script>` alike, so {@link cliArgs} drops the first two.
 *
 * See docs/adr/0007-runtime-neutral-engine.md.
 */

import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { basename, join } from "@std/path";

/** Output of a finished subprocess. Mirrors `Deno.Command#output()`. */
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `binary` with `args` and capture both output streams.
 *
 * Resolves for every exit code, including non-zero: callers classify failure
 * from `code`, exactly as they did with `Deno.Command#output()`. Rejects only
 * when the binary cannot be spawned at all — for example when `gh` is not
 * installed — which is the shape `createGitHubRepoWithFallback` relies on to
 * report "gh CLI is not available".
 *
 * Stdin is detached so a subprocess can never block on a prompt (a credential
 * prompt from `git ls-remote` would otherwise hang the CLI).
 */
export function runProcess(
  binary: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

/** Current working directory. */
export function currentDirectory(): string {
  return process.cwd();
}

/** CLI arguments: everything after the runtime and script/binary paths. */
export function cliArgs(): string[] {
  return process.argv.slice(2);
}

/**
 * Set the process exit code.
 *
 * Deliberately not `process.exit()`: exiting immediately can truncate buffered
 * stdout when output is piped, which would corrupt `--json` consumers. Setting
 * the code lets the event loop drain, and both runtimes honour it.
 */
export function exit(code: number): void {
  process.exitCode = code;
}

/** Read a file as UTF-8 text. Rejects when the file is missing. */
export function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/** Write UTF-8 text to a file, creating or truncating it. */
export function writeTextFile(path: string, text: string): Promise<void> {
  return writeFile(path, text, "utf8");
}

/** Create a directory and any missing parents. Succeeds if it exists. */
export async function makeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** A directory entry, carrying the parts of `Deno.DirEntry` this CLI uses. */
export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

/** List a directory. Rejects when it is missing or unreadable. */
export async function readDirectory(path: string): Promise<DirectoryEntry[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
  }));
}

/** One path visited by {@link walkDirectoryTree}. */
export interface WalkEntry {
  /** Path as joined from the walked root, never canonicalised. */
  path: string;
  /** Basename of the entry. */
  name: string;
  /** Whether the entry is a directory. Symlinks are never followed. */
  isDirectory: boolean;
}

/**
 * Walk `root` depth-first, returning directories and — when `includeFiles` is
 * true — files. Replaces `@std/fs`'s `walk`, which is Deno-only.
 *
 * Semantics are deliberately the ones `@std/fs/walk` had:
 *
 *  - the root itself is returned first, as a directory, so callers written
 *    against `walk` keep working unchanged;
 *  - `maxDepth` counts the root as depth 0, and a negative value walks nothing;
 *  - `skip` patterns are matched against the **whole path**, not the basename,
 *    and a skipped directory is neither returned nor descended into;
 *  - symlinks are never followed: a symlinked directory is not an
 *    `isDirectory: true` entry, its contents are not walked, and it is only
 *    returned at all when `includeFiles` is set.
 *
 * Unlike `walk` this returns a sorted-by-traversal array rather than an async
 * generator, because the CLI collects every result before ranking it anyway.
 */
export async function walkDirectoryTree(
  root: string,
  options: { maxDepth?: number; includeFiles?: boolean; skip?: RegExp[] } = {},
): Promise<WalkEntry[]> {
  const { maxDepth = Infinity, includeFiles = true, skip = [] } = options;
  if (maxDepth < 0) return [];

  const isSkipped = (candidate: string) =>
    skip.some((pattern) => candidate.match(pattern) !== null);
  const found: WalkEntry[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (isSkipped(dir)) return;
    found.push({ path: dir, name: basename(dir), isDirectory: true });
    if (depth >= maxDepth) return;

    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath, depth + 1);
      } else if (includeFiles && !isSkipped(entryPath)) {
        found.push({ path: entryPath, name: entry.name, isDirectory: false });
      }
    }
  };

  await visit(root, 0);
  return found;
}

/**
 * Whether a path exists, of any kind. Never rejects.
 *
 * Matches `@std/fs`'s `exists` for the cases this CLI hits, with one
 * deliberate divergence it does not share: a path that exists but cannot be
 * stat'd — permission denied, for instance — reads as absent here, where
 * `exists` reports it as present. Callers that must tell "missing" from
 * "unreadable" apart should use {@link readTextFile} or `stat` directly.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively delete a path. Like `Deno.remove(dir, { recursive: true })`, this
 * rejects — without deleting anything — when the path does not exist.
 */
export function removePath(path: string): Promise<void> {
  return rm(path, { recursive: true });
}

/** Create a unique temporary directory under the OS temp root. */
export function makeTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * True on Windows. `Deno.build.os` spells this `"windows"` and
 * `process.platform` spells it `"win32"`, so callers must not compare against
 * the literal themselves.
 */
export function isWindows(): boolean {
  return process.platform === "win32";
}
