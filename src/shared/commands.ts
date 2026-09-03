import { Buffer } from "node:buffer";
import { MAX_COMMAND_BYTES, MAX_OWNERS } from "./constants.js";
import type { GitHubIdentity, ParsedCommand } from "./types.js";
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

export type CommandWord = ParsedCommand["action"];

export interface RoutedCommand {
  id: string;
  command: ParsedCommand;
}

/** Read only the closed command word. Arguments are deliberately parsed later. */
export function commandWord(body: string): CommandWord | "unknown" | "ignore" {
  if (!body.startsWith("/lax")) return "ignore";
  const match = /^\/lax(?:\s+([^\s]+))?/u.exec(body);
  const word = match?.[1];
  if (word === "owners" || word === "submit" || word === "delete" || word === "register") {
    return word;
  }
  return "unknown";
}

export function parseCommand(body: string): ParsedCommand {
  if (Buffer.byteLength(body, "utf8") > MAX_COMMAND_BYTES) {
    throw new ValidationError(`command exceeds ${MAX_COMMAND_BYTES} bytes`);
  }
  const word = commandWord(body);
  if (word === "ignore" || word === "unknown") {
    throw new ValidationError("unknown command; use owners, submit, delete, or register");
  }
  if (word === "delete" || word === "register") {
    if (!new RegExp(`^/lax\\s+${word}\\s*$`, "u").test(body)) {
      throw new ValidationError(`/lax ${word} does not accept arguments`);
    }
    return { action: word };
  }
  const prefix = `/lax ${word}`;
  if (!body.startsWith(prefix) || !/\s/u.test(body.charAt(prefix.length))) {
    throw new ValidationError(`expected ${prefix} followed by JSON`);
  }
  const rawJson = body.slice(prefix.length).trim();
  if (rawJson === "") throw new ValidationError(`${word} requires a JSON argument`);
  const value = parseJson(rawJson, `${word} argument`);
  if (word === "submit") return { action: "submit", ...validateSource(value) };
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
  return { action: "owners", owners };
}

/**
 * Parse the submission id carried by current commands, then reuse the closed
 * command grammar. The fallback preserves comments emitted by issue-number-
 * based CLIs, where the issue number itself was the submission id.
 */
export function parseRoutedCommand(body: string, legacyId: string): RoutedCommand {
  const word = commandWord(body);
  if (word === "ignore" || word === "unknown") {
    return { id: legacyId, command: parseCommand(body) };
  }
  const id = commandSubmissionId(body, legacyId);
  const prefix = `/lax ${word}`;
  const remainder = body.slice(prefix.length);
  const match = /^\s+([^\s]+)/u.exec(remainder);
  const candidate = match?.[1];
  if (candidate === undefined || (!candidate.startsWith("lax-") && !candidate.startsWith("Lax"))) {
    return { id: legacyId, command: parseCommand(body) };
  }
  const rewritten = `${prefix}${remainder.slice(match![0].length)}`;
  return { id, command: parseCommand(rewritten) };
}

/** Read only the bounded routing id; arguments stay unparsed until after authorization. */
export function commandSubmissionId(body: string, legacyId: string): string {
  if (Buffer.byteLength(body, "utf8") > MAX_COMMAND_BYTES) {
    throw new ValidationError(`command exceeds ${MAX_COMMAND_BYTES} bytes`);
  }
  const word = commandWord(body);
  if (word === "ignore" || word === "unknown") return legacyId;
  const match = new RegExp(`^/lax\\s+${word}\\s+([^\\s]+)`, "u").exec(body);
  const candidate = match?.[1];
  if (candidate === undefined || (!candidate.startsWith("lax-") && !candidate.startsWith("Lax"))) {
    return legacyId;
  }
  try {
    return normalizeSubmissionId(candidate);
  } catch (error) {
    throw new ValidationError(`command submission id is invalid: ${(error as Error).message}`);
  }
}
