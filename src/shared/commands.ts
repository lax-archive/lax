import { Buffer } from "node:buffer";
import { MAX_COMMAND_BYTES, MAX_OWNERS } from "./constants.js";
import { isAdminVerb, type GitHubIdentity, type ParsedCommand } from "./types.js";
import {
  isObject,
  normalizeSubmissionId,
  parseJson,
  requireExactKeys,
  validateIdentity,
  validateSource,
  ValidationCollector,
  ValidationError,
} from "./validation.js";

/** The first word after `/lax`: the four author verbs, or `admin` for the maintainer form. */
export type CommandWord = "owners" | "submit" | "delete" | "register" | "admin";

export interface RoutedCommand {
  id: string;
  command: ParsedCommand;
}

/**
 * The closed command head, read before any argument: which verb the comment
 * names, whether it is the maintainer form, and the exact prefix everything
 * else follows. Every parser below starts here so the two grammars —
 * `/lax <verb> …` and `/lax admin <verb> …` — differ in one place only.
 */
export interface CommandHead {
  word: CommandWord;
  action: ParsedCommand["action"];
  prefix: string;
  admin: boolean;
}

/** Read only the closed command word. Arguments are deliberately parsed later. */
export function commandWord(body: string): CommandWord | "unknown" | "ignore" {
  if (!body.startsWith("/lax")) return "ignore";
  const match = /^\/lax(?:\s+([^\s]+))?/u.exec(body);
  const word = match?.[1];
  if (
    word === "owners" ||
    word === "submit" ||
    word === "delete" ||
    word === "register" ||
    word === "admin"
  ) {
    return word;
  }
  return "unknown";
}

/** The command head, or why there is none: an unknown verb is `unknown`, a non-command `ignore`. */
export function commandHead(body: string): CommandHead | "unknown" | "ignore" {
  const word = commandWord(body);
  if (word === "ignore" || word === "unknown") return word;
  if (word !== "admin") return { word, action: word, prefix: `/lax ${word}`, admin: false };
  const match = /^\/lax\s+admin(?:\s+([^\s]+))?/u.exec(body);
  const verb = match?.[1];
  if (!isAdminVerb(verb)) return "unknown";
  return { word, action: verb, prefix: `/lax admin ${verb}`, admin: true };
}

export function parseCommand(body: string): ParsedCommand {
  if (Buffer.byteLength(body, "utf8") > MAX_COMMAND_BYTES) {
    throw new ValidationError(`command exceeds ${MAX_COMMAND_BYTES} bytes`);
  }
  const head = commandHead(body);
  if (head === "ignore" || head === "unknown") {
    throw new ValidationError(
      "unknown command; use owners, submit, delete, register, or admin revalidate|delete|reset-draft|owners",
    );
  }
  const { action, prefix } = head;
  if (action === "delete" || action === "register" || action === "revalidate" || action === "reset-draft") {
    if (!new RegExp(`^${escapeRegExp(prefix).replace(/ /gu, "\\s+")}\\s*$`, "u").test(body)) {
      throw new ValidationError(`${prefix} does not accept arguments`);
    }
    if (action === "register") return { action };
    if (action === "delete") return head.admin ? { action, admin: true } : { action };
    return { action, admin: true };
  }
  if (!body.startsWith(prefix) || !/\s/u.test(body.charAt(prefix.length))) {
    throw new ValidationError(`expected ${prefix} followed by JSON`);
  }
  const rawJson = body.slice(prefix.length).trim();
  if (rawJson === "") throw new ValidationError(`${action} requires a JSON argument`);
  const value = parseJson(rawJson, `${action} argument`);
  if (action === "submit") return { action: "submit", ...validateSource(value) };
  if (!Array.isArray(value)) throw new ValidationError("owners must be a JSON array");
  const problems = new ValidationCollector();
  if (value.length === 0 || value.length > MAX_OWNERS) {
    problems.add(`owners must be a non-empty JSON array of at most ${MAX_OWNERS} entries`);
  }
  const owners: GitHubIdentity[] = [];
  value.forEach((entry, index) => {
    if (!isObject(entry)) {
      problems.add(`owner ${index + 1} must be an object`);
      return;
    }
    problems.capture(() => requireExactKeys(entry, ["githubId", "handle"], `owner ${index + 1}`));
    const owner = problems.capture(() => validateIdentity(entry, `owner ${index + 1}`));
    if (owner !== undefined) owners.push(owner);
  });
  const ids = new Set<number>();
  const handles = new Set<string>();
  for (const owner of owners) {
    const handle = owner.handle.toLowerCase();
    if (ids.has(owner.githubId)) problems.add(`duplicate owner id ${owner.githubId}`);
    if (handles.has(handle)) problems.add(`duplicate owner handle ${owner.handle}`);
    ids.add(owner.githubId);
    handles.add(handle);
  }
  problems.throwIfAny();
  owners.sort((left, right) => left.githubId - right.githubId);
  return head.admin ? { action: "owners", owners, admin: true } : { action: "owners", owners };
}

/**
 * Parse the submission id carried by current commands, then reuse the closed
 * command grammar. The fallback preserves comments emitted by issue-number-
 * based CLIs, where the issue number itself was the submission id.
 */
export function parseRoutedCommand(body: string, legacyId: string): RoutedCommand {
  const head = commandHead(body);
  if (head === "ignore" || head === "unknown") {
    return { id: legacyId, command: parseCommand(body) };
  }
  const id = commandSubmissionId(body, legacyId);
  const remainder = body.slice(head.prefix.length);
  const match = /^\s+([^\s]+)/u.exec(remainder);
  const candidate = match?.[1];
  if (candidate === undefined || (!candidate.startsWith("lax-") && !candidate.startsWith("Lax"))) {
    return { id: legacyId, command: parseCommand(body) };
  }
  const rewritten = `${head.prefix}${remainder.slice(match![0].length)}`;
  return { id, command: parseCommand(rewritten) };
}

/** Read only the bounded routing id; arguments stay unparsed until after authorization. */
export function commandSubmissionId(body: string, legacyId: string): string {
  if (Buffer.byteLength(body, "utf8") > MAX_COMMAND_BYTES) {
    throw new ValidationError(`command exceeds ${MAX_COMMAND_BYTES} bytes`);
  }
  const head = commandHead(body);
  if (head === "ignore" || head === "unknown") return legacyId;
  const pattern = new RegExp(`^${escapeRegExp(head.prefix).replace(/ /gu, "\\s+")}\\s+([^\\s]+)`, "u");
  const candidate = pattern.exec(body)?.[1];
  if (candidate === undefined || (!candidate.startsWith("lax-") && !candidate.startsWith("Lax"))) {
    return legacyId;
  }
  try {
    return normalizeSubmissionId(candidate);
  } catch (error) {
    throw new ValidationError(`command submission id is invalid: ${(error as Error).message}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
