import { listWorkspaces } from "../manifest.ts";
import type { CliOptions } from "../shared.ts";
import { printRows } from "../shared.ts";
import type { ResolvedWorkspace } from "../types.ts";

export function run(
  opts: CliOptions,
  resolved: ResolvedWorkspace,
): number {
  printRows(listWorkspaces(resolved), opts.json);
  return 0;
}
