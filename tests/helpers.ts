/**
 * Runtime-neutral test helpers. Tests run on Deno (`deno test`) and Bun
 * (`bun test`), so they use `node:test`, `node:assert/strict` and `node:fs`
 * instead of `Deno.*` and `@std/assert`.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a fresh temp directory (what `Deno.makeTempDir()` did). */
export function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ws-"));
}

/** Read a file as UTF-8 text. */
export function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

type ErrorClass = abstract new (...args: never[]) => Error;

function matches(
  error: unknown,
  errorClass: ErrorClass | undefined,
  messageIncludes: string | undefined,
): boolean {
  if (errorClass !== undefined && !(error instanceof errorClass)) return false;
  if (messageIncludes === undefined) return true;
  return error instanceof Error && error.message.includes(messageIncludes);
}

/**
 * Assert that `fn` throws an error of `errorClass` whose message contains
 * `messageIncludes`. Same call shape as `@std/assert`'s `assertThrows`.
 */
export function assertThrows(
  fn: () => unknown,
  errorClass?: ErrorClass,
  messageIncludes?: string,
): void {
  assert.throws(
    fn,
    (error: unknown) => matches(error, errorClass, messageIncludes),
  );
}

/** Async twin of {@link assertThrows}, like `@std/assert`'s `assertRejects`. */
export async function assertRejects(
  fn: () => Promise<unknown>,
  errorClass?: ErrorClass,
  messageIncludes?: string,
): Promise<void> {
  await assert.rejects(
    fn,
    (error: unknown) => matches(error, errorClass, messageIncludes),
  );
}
