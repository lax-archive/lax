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
    const end = closingDelimiter(value, index, opener);
    if (end === undefined) return false;
    if (!validEntryBody(type[0].toLowerCase(), value.slice(index + 1, end))) return false;
    entries += 1;
    index = end + 1;
  }
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

function closingDelimiter(
  value: string,
  start: number,
  opener: "{" | "(",
): number | undefined {
  let braces = opener === "{" ? 1 : 0;
  let quoted = false;
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
    if (character === '"' && braces === (opener === "{" ? 1 : 0)) {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "{") braces += 1;
    else if (character === "}") {
      if (braces === 0) return undefined;
      braces -= 1;
      if (opener === "{" && braces === 0) return index;
    } else if (opener === "(" && character === ")" && braces === 0) return index;
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
  if (atom.startsWith("{")) return closingDelimiter(atom, 0, "{") === atom.length - 1;
  if (!atom.startsWith('"')) return false;
  let braces = 0;
  let escaped = false;
  for (let index = 1; index < atom.length; index += 1) {
    const character = atom[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "{") braces += 1;
    else if (character === "}" && braces > 0) braces -= 1;
    else if (character === '"' && braces === 0) return index === atom.length - 1;
  }
  return false;
}

function splitTopLevel(value: string, delimiter: string): string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let braces = 0;
  let quoted = false;
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
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "{") braces += 1;
    else if (character === "}") {
      if (braces === 0) return undefined;
      braces -= 1;
    } else if (character === delimiter && braces === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (braces !== 0 || quoted || escaped) return undefined;
  parts.push(value.slice(start).trim());
  return parts;
}
