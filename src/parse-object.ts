/**
 * Parse a manifest into a plain object. An unparseable or non-object file is
 * the owning tool's to report, so it yields undefined here.
 */
export function parseObject(
  text: string,
  parse: (text: string) => unknown,
): Record<string, unknown> | undefined {
  try {
    const value = parse(text);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
