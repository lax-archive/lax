/** Validate one or more structurally complete BibTeX entries. */
export function isValidBibtex(value: string): boolean {
  let index = 0;
  let entries = 0;
  while (true) {
    index = skipTrivia(value, index);
    if (index === value.length) return entries > 0;
    if (value[index] !== "@") return false;
    const type = /^[A-Za-z][A-Za-z0-9_-]*/u.exec(value.slice(index + 1));
    if (type === null) return false;
    index += 1 + type[0].length;
    while (/\s/u.test(value[index] ?? "")) index += 1;
    const opener = value[index];
    if (opener !== "{" && opener !== "(") return false;
    const kind = type[0].toLowerCase();
    // Every entry but `@comment` holds field values, so a `"` that opens one
    // has to be read as a delimiter; a comment body is text no reader parses,
    // and a quote in it delimits nothing.
    const end = closingDelimiter(value, index, opener, kind === "comment" ? "text" : "values");
    if (end === undefined) return false;
    if (!validEntryBody(kind, value.slice(index + 1, end))) return false;
    entries += 1;
    index = kind === "comment" ? resumeAfterComment(value, end + 1) : end + 1;
  }
}

/**
 * Find where entries resume after the `@comment` group that ends just before
 * `from`.
 *
 * The two readers disagree about where a comment body ends, and both take the
 * file either way. bibtex reads no body at all: it resumes scanning at the
 * next `@`, wherever that falls. biber's btparse takes the brace group and
 * then merely warns about the text left over. A `}` inside a quoted run is
 * where the two part company — `@comment{Use "}" to close a group}` is one
 * comment to bibtex and a comment plus six characters of junk to biber — so
 * the group above is only a lower bound on the comment, and refusing what
 * follows it would cost the author the entries around a comment neither
 * reader complains about. It stays comment text up to the next `@`.
 */
function resumeAfterComment(value: string, from: number): number {
  const nextEntry = value.indexOf("@", from);
  return nextEntry === -1 ? value.length : nextEntry;
}

function skipTrivia(value: string, from: number): number {
  let index = from;
  while (index < value.length) {
    if (/\s/u.test(value[index]!)) {
      index += 1;
      continue;
    }
    if (value[index] !== "%") return index;
    const newline = value.indexOf("\n", index + 1);
    index = newline === -1 ? value.length : newline + 1;
  }
  return index;
}

/**
 * Find the delimiter that closes the group opened at `start`, or `undefined`
 * when nothing closes it.
 *
 * `contents` says which grammar the group holds, because a double quote is
 * only sometimes a delimiter. Among values a `"` standing at the group's own
 * depth opens a quoted value, which has to be skipped whole. In text — the
 * inside of a braced value, the body of an `@comment` — nothing is left for a
 * quote to delimit, so `"` is an ordinary character there and only braces are
 * matched. Both bibtex and biber read it that way: `{A 5" nail}` is a
 * perfectly good title, and counting that quote as a delimiter would swallow
 * the brace closing the value and reject the entry around it.
 */
function closingDelimiter(
  value: string,
  start: number,
  opener: "{" | "(",
  contents: "values" | "text",
): number | undefined {
  const groupDepth = opener === "{" ? 1 : 0;
  let braces = groupDepth;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"' && contents === "values" && braces === groupDepth) {
      const closingQuote = endOfQuotedValue(value, index);
      if (closingQuote === undefined) return undefined;
      index = closingQuote;
      continue;
    }
    if (character === "{") braces += 1;
    else if (character === "}") {
      if (braces === 0) return undefined;
      braces -= 1;
      if (opener === "{" && braces === 0) return index;
    } else if (opener === "(" && character === ")" && braces === 0) return index;
  }
  return undefined;
}

/**
 * Find the quote that closes the value opened at `start`, or `undefined` when
 * the value is never closed.
 *
 * Braces keep nesting inside a quoted value, and they are how a BibTeX value
 * hides a delimiter from the reader: a `"` reached below the value's own brace
 * depth is ordinary text, which is why `"a {5" nail} b"` is one value and not
 * two. A `}` that would drop under that depth is the unbalanced-braces error
 * bibtex reports, so the value counts as unclosed.
 */
function endOfQuotedValue(value: string, start: number): number | undefined {
  let braces = 0;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "{") braces += 1;
    else if (character === "}") {
      if (braces === 0) return undefined;
      braces -= 1;
    } else if (character === '"' && braces === 0) return index;
  }
  return undefined;
}

function validEntryBody(type: string, rawBody: string): boolean {
  const body = rawBody.trim();
  if (type === "comment") return true;
  if (type === "preamble") return validValue(body);
  if (type === "string") {
    const assignments = splitTopLevel(body, ",");
    const assignment = assignments?.length === 1 ? assignments[0] : undefined;
    return assignment !== undefined && validAssignment(assignment);
  }
  const parts = splitTopLevel(body, ",");
  if (parts === undefined || parts.length < 2) return false;
  const citationKey = parts.shift()!.trim();
  if (!/^[^\s,{}()]+$/u.test(citationKey)) return false;
  if (parts.at(-1)?.trim() === "") parts.pop();
  return parts.every((field) => field.trim() !== "" && validAssignment(field));
}

function validAssignment(raw: string): boolean {
  const parts = splitTopLevel(raw, "=");
  if (parts === undefined || parts.length !== 2) return false;
  return /^[A-Za-z][A-Za-z0-9_-]*$/u.test(parts[0]!.trim()) && validValue(parts[1]!.trim());
}

function validValue(value: string): boolean {
  const atoms = splitTopLevel(value, "#");
  return atoms !== undefined && atoms.length > 0 && atoms.every((atom) => validAtom(atom.trim()));
}

function validAtom(atom: string): boolean {
  if (/^[+-]?\d+$/u.test(atom) || /^[A-Za-z][A-Za-z0-9_:+./-]*$/u.test(atom)) return true;
  if (atom.startsWith("{")) return closingDelimiter(atom, 0, "{", "text") === atom.length - 1;
  if (!atom.startsWith('"')) return false;
  return endOfQuotedValue(atom, 0) === atom.length - 1;
}

function splitTopLevel(value: string, delimiter: string): string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let braces = 0;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"' && braces === 0) {
      const closingQuote = endOfQuotedValue(value, index);
      if (closingQuote === undefined) return undefined;
      index = closingQuote;
      continue;
    }
    if (character === "{") braces += 1;
    else if (character === "}") {
      if (braces === 0) return undefined;
      braces -= 1;
    } else if (character === delimiter && braces === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (braces !== 0 || escaped) return undefined;
  parts.push(value.slice(start).trim());
  return parts;
}
