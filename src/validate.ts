/**
 * General-purpose name validation utilities. Used by manifest, worktree,
 * and command modules to reject names that could cause path traversal or
 * filesystem confusion.
 */

export function validateSafeName(name: string, contextName = "Name"): void {
  if (!name || typeof name !== "string" || name.trim() === "") {
    throw new Error(`${contextName} cannot be empty`);
  }
  if (
    name.includes("/") || name.includes("\\") || name === "." ||
    name === ".." || name.includes("..")
  ) {
    throw new Error(
      `${contextName} "${name}" contains invalid characters or path traversal`,
    );
  }
}
