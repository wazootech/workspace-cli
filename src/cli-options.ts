/** Options parsed from the CLI invocation, shared by every command module. */
export interface CliOptions {
  command: string;
  subcommand?: string;
  manifestPath?: string;
  host?: string;
  owner?: string;
  url?: string;
  name?: string;
  visibility?: string;
  create: boolean;
  json: boolean;
  dryRun: boolean;
  positional: string[];
  workspace?: string;
  asWorkspace?: boolean;
  /** sweep: also delete origin/<branch> after a proven merge. */
  deleteRemote?: boolean;
  /** sweep: override the merge-proof and clean-tree gates. */
  force?: boolean;
  /** sweep: treat refusals as failures, not just reported rows. */
  strict?: boolean;
}
