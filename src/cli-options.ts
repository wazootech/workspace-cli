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
}
