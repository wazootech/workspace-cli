/**
 * Surgical, comment-preserving edits to the repositories collection of a
 * workspace manifest. Pure text-in/text-out: functions return the new
 * document text or throw ManifestEditError without side effects.
 * Unrecognized layouts fail closed so a malformed file is never half-edited.
 */
import { resolveRepository } from "./resolve.ts";

// --- Shared JSONC state helpers ---

interface JsoncState {
  i: number;
  inLineComment: boolean;
  inBlockComment: boolean;
  strStart: number;
  quote: string;
  escaped: boolean;
}

function skipLineComment(raw: string, state: JsoncState): void {
  while (state.i < raw.length && raw[state.i] !== "\n") state.i++;
  state.inLineComment = false;
}

function skipBlockComment(raw: string, state: JsoncState): void {
  while (state.i < raw.length) {
    if (raw[state.i] === "*" && raw[state.i + 1] === "/") {
      state.i += 2;
      state.inBlockComment = false;
      return;
    }
    state.i++;
  }
}

function skipString(raw: string, state: JsoncState): string | null {
  const start = state.i;
  state.strStart = start;
  state.escaped = false;
  state.i++;
  while (state.i < raw.length) {
    const ch = raw[state.i];
    if (state.escaped) {
      state.escaped = false;
    } else if (ch === "\\") {
      state.escaped = true;
    } else if (ch === state.quote) {
      const token = raw.slice(start, state.i);
      state.strStart = -1;
      state.i++;
      return token;
    }
    state.i++;
  }
  state.strStart = -1;
  return null;
}

export class ManifestEditError extends Error {}

/** Entry forms accepted by add/remove, mirroring schema v4 authoring. */
export type NewEntry =
  | { kind: "shorthand"; raw: string }
  | { kind: "object"; name: string; url: string };

/** Render an entry as it is written into .json/.jsonc manifests. */
export function formatEntryJsonc(entry: NewEntry): string {
  if (entry.kind === "shorthand") {
    return JSON.stringify(entry.raw);
  }
  return `{ "name": ${JSON.stringify(entry.name)}, "url": ${
    JSON.stringify(entry.url)
  } }`;
}

/**
 * Insert an entry into the repositories array of a .json/.jsonc document,
 * leaving all bytes outside the touched span untouched.
 */
export function addEntryJsonc(raw: string, entryText: string): string {
  return spliceIntoScan(raw, locateJsoncRepositoriesArray(raw), entryText);
}

/**
 * Remove the entry whose effective repository name equals `targetName` from
 * a .json/.jsonc document. Shorthand scalars resolve through expandShorthand
 * so "owner/name" and bare-string entries match by post-expansion name.
 */
export function removeEntryJsonc(
  raw: string,
  targetName: string,
  owner?: string,
  host = "github.com",
): string {
  const scan = locateJsoncRepositoriesArray(raw);
  for (const el of scan.elements) {
    const elementRaw = raw.slice(el.start, el.end);
    if (jsonElementName(elementRaw, owner, host) !== targetName) continue;
    return spliceOutSpan(raw, el);
  }
  throw new ManifestEditError(
    `Repository "${targetName}" not found in manifest`,
  );
}

interface ArrayScan {
  arrayStart: number;
  arrayEnd: number;
  /** Element spans with absolute indices into raw, trimmed of whitespace. */
  elements: { start: number; end: number }[];
}

function locateJsoncRepositoriesArray(raw: string): ArrayScan {
  const open = findJsoncKeyArrayOpen(raw);
  return scanBracketSpan(raw, open);
}

function findJsoncKeyArrayOpen(raw: string): number {
  const s: JsoncState = {
    i: 0,
    inLineComment: false,
    inBlockComment: false,
    strStart: -1,
    quote: "",
    escaped: false,
  };
  let depth = 0;
  while (s.i < raw.length) {
    const ch = raw[s.i];
    const next = raw[s.i + 1];
    if (s.inLineComment) {
      skipLineComment(raw, s);
      continue;
    }
    if (s.inBlockComment) {
      skipBlockComment(raw, s);
      continue;
    }
    if (s.strStart !== -1) {
      const token = skipString(raw, s);
      if (
        s.strStart === -1 && depth === 1 && token === "repositories"
      ) {
        let j = s.i;
        while (j < raw.length && /\s/.test(raw[j])) j++;
        if (raw[j] !== ":") continue;
        j++;
        while (j < raw.length && /\s/.test(raw[j])) j++;
        if (raw[j] !== "[") {
          throw new ManifestEditError(
            `"repositories" is not an array in this manifest`,
          );
        }
        return j;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      s.inLineComment = true;
      s.i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      s.inBlockComment = true;
      s.i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      s.strStart = s.i;
      s.quote = ch;
      s.escaped = false;
      s.i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    s.i++;
  }
  throw new ManifestEditError(
    `No "repositories" array found in manifest`,
  );
}

function scanBracketSpan(raw: string, start: number): ArrayScan {
  const s: JsoncState = {
    i: start + 1,
    inLineComment: false,
    inBlockComment: false,
    strStart: -1,
    quote: "",
    escaped: false,
  };
  let depth = 1;
  const elements: ArrayScan["elements"] = [];
  let elStart = -1;
  let elEnd = -1;

  const mark = (pos: number): void => {
    if (!/\s/.test(raw[pos])) {
      if (elStart === -1) elStart = pos;
      elEnd = pos + 1;
    }
  };
  const flush = (): void => {
    if (elStart !== -1 && elEnd > elStart) {
      elements.push({ start: elStart, end: elEnd });
    }
    elStart = -1;
    elEnd = -1;
  };

  while (s.i < raw.length) {
    const ch = raw[s.i];
    const next = raw[s.i + 1];
    if (s.inLineComment) {
      skipLineComment(raw, s);
      continue;
    }
    if (s.inBlockComment) {
      skipBlockComment(raw, s);
      continue;
    }
    if (s.strStart !== -1) {
      mark(s.i);
      if (s.escaped) s.escaped = false;
      else if (ch === "\\") s.escaped = true;
      else if (ch === s.quote) s.strStart = -1;
      s.i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      s.inLineComment = true;
      s.i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      s.inBlockComment = true;
      s.i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      s.strStart = s.i;
      s.quote = ch;
      s.escaped = false;
      mark(s.i);
      s.i++;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth++;
      mark(s.i);
      s.i++;
      continue;
    }
    if (ch === "]") {
      if (depth === 1) {
        flush();
        return { arrayStart: start, arrayEnd: s.i, elements };
      }
      depth--;
      mark(s.i);
      s.i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      mark(s.i);
      s.i++;
      continue;
    }
    if (ch === "," && depth === 1) {
      flush();
      s.i++;
      continue;
    }
    mark(s.i);
    s.i++;
  }
  throw new ManifestEditError(`Unterminated repositories array`);
}

function spliceIntoScan(
  raw: string,
  scan: ArrayScan,
  entryText: string,
): string {
  const body = raw.slice(scan.arrayStart + 1, scan.arrayEnd);
  const keyLineStart = raw.lastIndexOf("\n", scan.arrayStart) + 1;
  const keyIndent = /^[ \t]*/.exec(raw.slice(keyLineStart, scan.arrayStart))![
    0
  ];

  if (scan.elements.length === 0) {
    if (body.trim() !== "") {
      throw new ManifestEditError(
        `repositories array contains only comments; edit it manually`,
      );
    }
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const replacement = `[${eol}${keyIndent}  ${entryText}${eol}${keyIndent}]`;
    return raw.slice(0, scan.arrayStart) + replacement +
      raw.slice(scan.arrayEnd + 1);
  }

  const last = scan.elements[scan.elements.length - 1];
  const middle = raw.slice(last.end, scan.arrayEnd);
  const hadTrailingComma = /^[ \t]*,/.test(middle);
  const middleRest = middle.replace(/^[ \t]*,/, "");
  const multiline = middleRest.includes("\n") ||
    body.slice(0, last.start - (scan.arrayStart + 1)).includes("\n");
  let lineIndent = keyIndent + "  ";
  if (multiline) {
    const ls = raw.lastIndexOf("\n", last.start) + 1;
    lineIndent = /^[ \t]*/.exec(raw.slice(ls, last.start))![0];
  }
  const eol = multiline && body.includes("\r\n") ? "\r\n" : "\n";
  const separator = multiline ? `,${eol}${lineIndent}` : ", ";
  const rebuilt = raw.slice(scan.arrayStart + 1, last.end) + separator +
    entryText +
    (hadTrailingComma ? "," : "") + middleRest;
  return raw.slice(0, scan.arrayStart + 1) + rebuilt +
    raw.slice(scan.arrayEnd);
}

function spliceOutSpan(
  raw: string,
  el: { start: number; end: number },
): string {
  let delStart = el.start;
  let delEnd = el.end;
  if (raw[delEnd] === ",") {
    delEnd++;
  } else {
    // No following comma: consume the preceding one across any whitespace
    // gap so a dangling separator is never left behind.
    let j = delStart - 1;
    while (j >= 0 && /[ \t\r\n]/.test(raw[j])) j--;
    if (raw[j] === ",") delStart = j;
  }
  // Collapse a doubled single-space seam left on inline arrays.
  const beforeDel = delStart > 0 ? raw[delStart - 1] : "";
  if (
    (beforeDel === "[" || beforeDel === "," || beforeDel === " ") &&
    raw[delEnd] === " "
  ) {
    delEnd++;
  }
  // When the element owned its line, swallow the leftover indentation so no
  // blank line remains.
  let k = delStart - 1;
  while (k >= 0 && /[ \t]/.test(raw[k])) k--;
  const precededByNewline = k >= 0 && raw[k] === "\n";
  const followedByEol = (() => {
    let p = delEnd;
    while (p < raw.length && /[ \t]/.test(raw[p])) p++;
    return p >= raw.length || raw[p] === "\n";
  })();
  if (precededByNewline && followedByEol) delStart = k;
  return raw.slice(0, delStart) + raw.slice(delEnd);
}

function jsonElementName(
  elementRaw: string,
  owner: string | undefined,
  host: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(elementRaw);
  } catch {
    return "";
  }
  return parsedEntryName(parsed, owner, host);
}

function parsedEntryName(
  parsed: unknown,
  owner: string | undefined,
  host: string,
): string {
  if (typeof parsed === "string") {
    // Unexpandable scalars (no resolvable owner) simply never match a
    // removal target; removal must not explode on unrelated entries.
    try {
      return resolveRepository({ host, owner }, parsed).name;
    } catch {
      return "";
    }
  }
  if (
    typeof parsed === "object" && parsed !== null &&
    typeof (parsed as { name?: unknown }).name === "string"
  ) {
    return (parsed as { name: string }).name;
  }
  return "";
}
