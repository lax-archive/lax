import { Buffer } from "node:buffer";
import { MAX_COMMAND_BYTES, MAX_OWNERS } from "./constants.js";
import type { GitHubIdentity, ParsedCommand } from "./types.js";
import {
  isObject,
  parseJson,
  requireExactKeys,
  validateIdentity,
  validateSource,
  ValidationCollector,
  ValidationError,
} from "./validation.js";

export type CommandWord = ParsedCommand["action"];

/** Read only the closed command word. Arguments are deliberately parsed later. */
export function commandWord(body: string): CommandWord | "unknown" | "ignore" {
  if (!body.startsWith("/lax")) return "ignore";
  const match = /^\/lax(?:\s+([^\s]+))?/u.exec(body);
  const word = match?.[1];
  if (word === "owners" || word === "update" || word === "delete" || word === "register") {
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
    throw new ValidationError("unknown command; use owners, update, delete, or register");
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
  if (word === "update") return { action: "update", ...validateSource(value) };
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
