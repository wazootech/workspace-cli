/**
 * Runtime edge — the one module in `src/` that reaches outside `@std`.
 *
 * `wspace` runs two ways: on Deno (as a compiled binary or via `deno run`) and
 * on Node (via the JSR npm-compatibility package). Deno's `Deno.*` globals do
 * not exist on Node, so every such call is replaced with a `node:` builtin
 * here; Deno implements the `node:` specifiers natively, so a single
 * implementation serves both runtimes. Nothing else in `src/` may import
 * `node:*`.
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
import { join } from "@std/path";

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

/** Whether a path exists, of any kind. Never rejects. */
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
