import { describe, expect, it } from "vitest";
import {
  commandHead,
  commandSubmissionId,
  commandWord,
  parseCommand,
  parseRoutedCommand,
} from "../../src/shared/commands.js";
import { MAX_COMMAND_BYTES, MAX_OWNERS } from "../../src/shared/constants.js";

describe("issue command parser", () => {
  it("silently ignores ordinary comments and closes the command vocabulary", () => {
    expect(commandWord("looks good")).toBe("ignore");
    expect(commandWord(" /lax delete")).toBe("ignore");
    expect(commandWord("/lax surprise")).toBe("unknown");
  });

  it("parses an exact immutable submit request", () => {
    expect(
      parseCommand(
        '/lax submit {"repository":"https://github.com/alice/formalization","commit":"0123456789abcdef0123456789abcdef01234567","folder":"."}',
      ),
    ).toEqual({
      action: "submit",
      repository: "https://github.com/alice/formalization",
      commit: "0123456789abcdef0123456789abcdef01234567",
      folder: ".",
    });
  });

  it("routes current commands by their embedded six-digit submission id", () => {
    const source =
      '{"repository":"https://github.com/alice/formalization","commit":"0123456789abcdef0123456789abcdef01234567","folder":"."}';
    expect(commandSubmissionId(`/lax submit lax-123456 ${source}`, "lax-42")).toBe(
      "lax-123456",
    );
    expect(parseRoutedCommand(`/lax submit lax-123456 ${source}`, "lax-42")).toEqual({
      id: "lax-123456",
      command: {
        action: "submit",
        repository: "https://github.com/alice/formalization",
        commit: "0123456789abcdef0123456789abcdef01234567",
        folder: ".",
      },
    });
    expect(parseRoutedCommand("/lax delete lax-123456", "lax-42")).toEqual({
      id: "lax-123456",
      command: { action: "delete" },
    });
  });

  it("retains issue-derived routing for commands emitted by older CLIs", () => {
    expect(parseRoutedCommand("/lax delete", "lax-42")).toEqual({
      id: "lax-42",
      command: { action: "delete" },
    });
    expect(() => commandSubmissionId("/lax delete lax-012345", "lax-42")).toThrow(
      "command submission id is invalid",
    );
  });

  it("rejects unknown JSON fields and trailing command arguments", () => {
    expect(() =>
      parseCommand(
        '/lax submit {"repository":"https://github.com/alice/repo","commit":"0123456789abcdef0123456789abcdef01234567","folder":".","id":"lax-4"}',
      ),
    ).toThrow("exactly");
    expect(() => parseCommand("/lax delete lax-4")).toThrow("does not accept arguments");
    expect(() => parseCommand('/lax submit {"repository":true} {"folder":"."}')).toThrow(
      "not valid JSON",
    );
  });

  it("sorts owners and rejects duplicate identities", () => {
    expect(
      parseCommand(
        '/lax owners [{"githubId":20,"handle":"bob"},{"githubId":10,"handle":"alice"}]',
      ),
    ).toEqual({
      action: "owners",
      owners: [
        { githubId: 10, handle: "alice" },
        { githubId: 20, handle: "bob" },
      ],
    });
    expect(() =>
      parseCommand(
        '/lax owners [{"githubId":10,"handle":"alice"},{"githubId":10,"handle":"alice-renamed"}]',
      ),
    ).toThrow("duplicate owner id");
  });

  it("enforces the command byte boundary before parsing", () => {
    const exact = "/lax delete" + " ".repeat(MAX_COMMAND_BYTES - Buffer.byteLength("/lax delete"));
    expect(Buffer.byteLength(exact)).toBe(MAX_COMMAND_BYTES);
    expect(parseCommand(exact)).toEqual({ action: "delete" });
    expect(() => parseCommand(`${exact} `)).toThrow(`exceeds ${MAX_COMMAND_BYTES} bytes`);
  });

  it("does not accept ambiguous prefixes, command words or trailing data", () => {
    expect(commandWord("/laxdelete")).toBe("unknown");
    expect(commandWord("/LAX delete")).toBe("ignore");
    expect(commandWord("\t/lax delete")).toBe("ignore");
    expect(() => parseCommand("/lax register now")).toThrow("does not accept arguments");
    expect(() => parseCommand("/lax owners [] trailing")).toThrow("not valid JSON");
    expect(() => parseCommand("/lax owners")).toThrow("expected /lax owners followed by JSON");
  });

  it("enforces owner-count boundaries", () => {
    const owners = Array.from({ length: MAX_OWNERS }, (_, index) => ({
      githubId: index + 1,
      handle: `owner-${index + 1}`,
    }));
    expect(parseCommand(`/lax owners ${JSON.stringify(owners)}`)).toMatchObject({
      action: "owners",
      owners,
    });
    expect(() => parseCommand(`/lax owners ${JSON.stringify([...owners, { githubId: 51, handle: "owner-51" }])}`)).toThrow(
      `at most ${MAX_OWNERS}`,
    );
    expect(() => parseCommand("/lax owners []")).toThrow("non-empty");
  });

  it("aggregates independent owner-entry and duplicate errors", () => {
    const body = `/lax owners ${JSON.stringify([
      { githubId: 1, handle: "alice", extra: true },
      { githubId: 1, handle: "ALICE" },
      { githubId: 0, handle: "-bad" },
      null,
    ])}`;
    try {
      parseCommand(body);
      throw new Error("expected validation to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("owner 1 must contain exactly");
      expect(message).toContain("duplicate owner id 1");
      expect(message).toContain("duplicate owner handle ALICE");
      expect(message).toContain("owner 3 has an invalid numeric account id");
      expect(message).toContain("owner 3 has an invalid handle");
      expect(message).toContain("owner 4 must be an object");
    }
  });
});

describe("maintainer command grammar", () => {
  it("reads the maintainer head from the closed vocabulary only", () => {
    expect(commandWord("/lax admin revalidate")).toBe("admin");
    expect(commandHead("/lax admin revalidate lax-123456")).toEqual({
      word: "admin",
      action: "revalidate",
      prefix: "/lax admin revalidate",
      admin: true,
    });
    expect(commandHead("/lax admin frobnicate")).toBe("unknown");
    expect(commandHead("/lax admin")).toBe("unknown");
    expect(commandHead("/lax delete")).toEqual({
      word: "delete",
      action: "delete",
      prefix: "/lax delete",
      admin: false,
    });
  });

  it("routes maintainer verbs by the same embedded id and marks the parsed command", () => {
    expect(commandSubmissionId("/lax admin revalidate lax-123456", "lax-42")).toBe("lax-123456");
    expect(commandSubmissionId("/lax admin reset-draft", "lax-42")).toBe("lax-42");
    expect(parseRoutedCommand("/lax admin revalidate lax-123456", "lax-42")).toEqual({
      id: "lax-123456",
      command: { action: "revalidate", admin: true },
    });
    expect(parseRoutedCommand("/lax admin delete", "lax-42")).toEqual({
      id: "lax-42",
      command: { action: "delete", admin: true },
    });
    expect(parseRoutedCommand("/lax admin reset-draft lax-42", "lax-42")).toEqual({
      id: "lax-42",
      command: { action: "reset-draft", admin: true },
    });
    expect(
      parseRoutedCommand('/lax admin owners lax-123456 [{"githubId":20,"handle":"bob"}]', "lax-42"),
    ).toEqual({
      id: "lax-123456",
      command: { action: "owners", owners: [{ githubId: 20, handle: "bob" }], admin: true },
    });
    // the author form never carries the flag
    expect(parseCommand("/lax delete")).toEqual({ action: "delete" });
  });

  it("keeps the argument rules of the underlying verb", () => {
    expect(() => parseCommand("/lax admin revalidate extra")).toThrow("does not accept arguments");
    expect(() => parseCommand("/lax admin reset-draft lax-42 now")).toThrow("does not accept arguments");
    expect(() => parseCommand("/lax admin owners")).toThrow("followed by JSON");
    expect(() => parseCommand("/lax admin owners ")).toThrow("requires a JSON argument");
    expect(() => parseCommand("/lax admin owners {}")).toThrow("owners must be a JSON array");
    expect(() => parseCommand("/lax admin register")).toThrow("unknown command");
    expect(() => parseCommand("/lax admin submit {}")).toThrow("unknown command");
  });
});
