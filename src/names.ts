/**
 * Repository and owner name validation, aligned with GitHub's naming rules.
 *
 * - Owner segments (organizations / usernames): ASCII alphanumerics and single
 *   hyphens, no leading/trailing hyphen, max 39 chars. Dots and underscores
 *   are not allowed.
 * - Repository names: ASCII alphanumerics plus `-`, `_`, `.`, max 100 chars.
 *   `.` and `..` are reserved, and names cannot end with `.git` or `.wiki`.
 */

export const MAX_OWNER_LENGTH = 39;
export const MAX_REPO_NAME_LENGTH = 100;

const OWNER_REGEX = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/;
const REPO_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

/**
 * Validate a GitHub owner segment (organization or username). GitHub allows
 * ASCII alphanumerics and single hyphens only: no leading/trailing hyphen, no
 * consecutive hyphens, max 39 characters.
 */
export function validateOwnerSegment(owner: string | undefined): string {
  if (typeof owner !== "string" || owner === "") {
    throw new Error(`Invalid repository owner: '${owner}'`);
  }
  if (owner.length > MAX_OWNER_LENGTH) {
    throw new Error(
      `Invalid repository owner: '${owner}' (max ${MAX_OWNER_LENGTH} characters)`,
    );
  }
  if (!OWNER_REGEX.test(owner)) {
    throw new Error(
      `Invalid repository owner: '${owner}' (allowed: letters, digits, and single hyphens)`,
    );
  }
  return owner;
}

/**
 * Validate a GitHub repository name. GitHub allows ASCII alphanumerics plus
 * `-`, `_`, and `.`, max 100 characters. `.` and `..` are reserved, names
 * cannot end with `.git`, and path separators / traversal are rejected.
 */
export function validateRepositoryName(name: string): string {
  if (typeof name !== "string" || name === "") {
    throw new Error(`Invalid repository name: '${name}'`);
  }
  if (name.length > MAX_REPO_NAME_LENGTH) {
    throw new Error(
      `Invalid repository name: '${name}' (max ${MAX_REPO_NAME_LENGTH} characters)`,
    );
  }
  if (!REPO_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid repository name: '${name}' contains invalid characters or path traversal (allowed: letters, digits, '.', '_', '-')`,
    );
  }
  if (name === "." || name === ".." || name.includes("..")) {
    throw new Error(`Invalid repository name: '${name}' (reserved)`);
  }
  if (name.endsWith(".git")) {
    throw new Error(
      `Invalid repository name: '${name}' (cannot end with .git)`,
    );
  }
  // Community-tested: GitHub rejects ".wiki" suffix with
  // "The repository REPO cannot end in .wiki". Not yet in official docs.
  // https://github.com/github/docs/issues/44518
  if (name.endsWith(".wiki")) {
    throw new Error(
      `Invalid repository name: '${name}' (cannot end with .wiki)`,
    );
  }
  return name;
}
