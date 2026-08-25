/**
 * Surgical, comment-preserving edits to the repositories collection of a
 * workspace manifest. Pure text-in/text-out: functions return the new
 * document text or throw ManifestEditError without side effects.
 * Unrecognized layouts fail closed so a malformed file is never half-edited.
 */
import { parse as parseYaml } from "@std/yaml";
import { expandShorthand } from "./manifest.ts";

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

/** Render an entry as it is written into .yaml/.yml manifests. */
export function formatEntryYaml(entry: NewEntry): string {
  if (entry.kind === "shorthand") {
    return entry.raw;
  }
  return `{ name: ${entry.name}, url: ${entry.url} }`;
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

/**
 * Insert an entry into the repositories collection of a .yaml/.yml document.
 * Block sequences append an item; flow sequences delegate to the bracket
 * scanner.
 */
export function addEntryYaml(raw: string, entryText: string): string {
  const flow = locateYamlFlowArray(raw);
  if (flow !== undefined) {
    return spliceIntoScan(raw, flow, entryText);
  }
  const block = scanYamlBlockItems(raw);
  const indent = " ".repeat(block.appendIndent);
  const insertAt = block.appendAt;
  // Appending at end-of-file keeps the file's final-newline convention: the
  // new item becomes the last line with its own terminator.
  if (insertAt >= raw.length && raw.endsWith("\n")) {
    return raw + `${indent}- ${entryText}\n`;
  }
  // If the cursor sits just past a newline (blank line mid-file), the item
  // line needs no extra separator.
  const leadingNewline = insertAt > 0 && raw[insertAt - 1] === "\n" ? "" : "\n";
  return raw.slice(0, insertAt) + `${leadingNewline}${indent}- ${entryText}` +
    raw.slice(insertAt);
}

/**
 * Remove the entry whose effective repository name equals `targetName` from
 * a .yaml/.yml document, block or flow form.
 */
export function removeEntryYaml(
  raw: string,
  targetName: string,
  owner?: string,
  host = "github.com",
): string {
  const flow = locateYamlFlowArray(raw);
  if (flow !== undefined) {
    for (const el of flow.elements) {
      let parsed: unknown;
      try {
        parsed = parseYaml(raw.slice(el.start, el.end));
      } catch {
        continue;
      }
      if (parsedEntryName(parsed, owner, host) !== targetName) continue;
      return spliceOutSpan(raw, el);
    }
    throw new ManifestEditError(
      `Repository "${targetName}" not found in manifest`,
    );
  }
  const block = scanYamlBlockItems(raw);
  for (const item of block.items) {
    if (parsedEntryName(parseYaml(item.text), owner, host) !== targetName) {
      continue;
    }
    return raw.slice(0, item.removeStart) + raw.slice(item.removeEnd);
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

interface YamlBlockScan {
  appendAt: number;
  appendIndent: number;
  items: {
    text: string;
    removeStart: number;
    removeEnd: number;
  }[];
}

interface Line {
  text: string;
  start: number;
  /** Index just past this line's terminator (or EOF). */
  eol: number;
}

function splitLines(raw: string): Line[] {
  const lines: Line[] = [];
  let p = 0;
  while (p <= raw.length) {
    const nl = raw.indexOf("\n", p);
    const end = nl === -1 ? raw.length : nl;
    lines.push({
      text: raw.slice(p, end),
      start: p,
      eol: nl === -1 ? raw.length : nl + 1,
    });
    if (nl === -1) break;
    p = nl + 1;
  }
  return lines;
}

function indentOf(lineText: string): number {
  const m = /^[ \t]*/.exec(lineText);
  return m !== null ? m[0].length : 0;
}

function scanYamlBlockItems(raw: string): YamlBlockScan {
  const lines = splitLines(raw);
  let keyIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^repositories:\s*$/.test(lines[i].text)) {
      keyIdx = i;
      break;
    }
  }
  if (keyIdx === -1) {
    throw new ManifestEditError(
      `No top-level "repositories:" key found in YAML manifest`,
    );
  }
  const keyIndent = indentOf(lines[keyIdx].text);
  const items: YamlBlockScan["items"] = [];
  let itemIndent = keyIndent + 2;
  let appendAt = lines[keyIdx].eol;
  for (let i = keyIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.text.trim() === "") continue;
    const ind = indentOf(line.text);
    if (ind <= keyIndent) break;
    if (!line.text.trimStart().startsWith("- ")) break;
    itemIndent = ind;
    const contentLines = [line.text.trimStart().slice(2)];
    let groupLast = i;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const cont = lines[j];
      if (cont.text.trim() === "") break;
      const contInd = indentOf(cont.text);
      if (contInd <= itemIndent) break;
      if (cont.text.trimStart().startsWith("- ")) break;
      contentLines.push(cont.text.trimStart());
      groupLast = j;
    }
    items.push({
      text: contentLines.join("\n"),
      removeStart: line.start,
      removeEnd: lines[groupLast].eol,
    });
    appendAt = lines[groupLast].eol;
    i = j - 1;
  }
  return { appendAt, appendIndent: itemIndent, items };
}

function locateYamlFlowArray(raw: string): ArrayScan | undefined {
  const keyMatch = /^repositories:[ \t]*/m.exec(raw);
  if (keyMatch === null || keyMatch.index === undefined) {
    throw new ManifestEditError(
      `No top-level "repositories:" key found in YAML manifest`,
    );
  }
  const valueStart = keyMatch.index + keyMatch[0].length;
  const lineEnd = raw.indexOf("\n", valueStart);
  const open = raw.indexOf("[", valueStart);
  if (open === -1 || (lineEnd !== -1 && open > lineEnd)) {
    return undefined;
  }
  return scanBracketSpan(raw, open);
}

function locateJsoncRepositoriesArray(raw: string): ArrayScan {
  const open = findJsoncKeyArrayOpen(raw);
  return scanBracketSpan(raw, open);
}

function findJsoncKeyArrayOpen(raw: string): number {
  let i = 0;
  let depth = 0;
  let strStart = -1;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      i++;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (strStart !== -1) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) {
        const token = raw.slice(strStart + 1, i);
        strStart = -1;
        if (depth === 1 && token === "repositories") {
          let j = i + 1;
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
      }
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      strStart = i;
      quote = ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  throw new ManifestEditError(
    `No "repositories" array found in manifest`,
  );
}

function scanBracketSpan(raw: string, start: number): ArrayScan {
  // The array's own opening bracket is boundary, not content: begin inside
  // it so element spans never include it.
  let i = start + 1;
  let depth = 1;
  let strStart = -1;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
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

  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      i++;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (strStart !== -1) {
      mark(i);
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) strStart = -1;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      strStart = i;
      quote = ch;
      escaped = false;
      mark(i);
      i++;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth++;
      mark(i);
      i++;
      continue;
    }
    if (ch === "]") {
      if (depth === 1) {
        flush();
        return { arrayStart: start, arrayEnd: i, elements };
      }
      depth--;
      mark(i);
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      mark(i);
      i++;
      continue;
    }
    if (ch === "," && depth === 1) {
      flush();
      i++;
      continue;
    }
    mark(i);
    i++;
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
      return expandShorthand("manifest-edit", parsed, owner, host).name;
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
