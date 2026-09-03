import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("CLI compatibility surface", () => {
  it("prints the package version", () => {
    const { version } = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { version: string };
    expect(cli(["--version"])).toEqual({ code: 0, output: `${version}\n` });
  });

  it("opens with the commands in the order an author meets them", () => {
    // `lax --help` is a curated overview, not commander's alphabetical dump of
    // every flag: the options live behind `lax <command> --help`.
    const help = cli(["--help"]);
    expect(help.code).toBe(0);
    const lines = help.output.split("\n");
    const order = ["lax doctor", "lax login", "lax init", "lax build", "lax serve", "lax submit", "lax register"];
    const positions = order.map((command) =>
      lines.findIndex((line) => line.trimStart().startsWith(`${command} `) || line.trim() === command),
    );
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // and the rest are named without being explained twice
    expect(help.output).toContain("lax owners · lax delete · lax sync · lax update · lax logout");
    expect(help.output).toContain("lax print spec · lax print instructions");
    expect(help.output).toContain("lax <command> --help for options");
  });

  it("makes every `init` loginless without exposing the retired opt-in", () => {
    const init = cli(["init", "--help"]);
    expect(init.code).toBe(0);
    expect(init.output).toContain("--title <title>");
    expect(init.output).toContain("local six-digit id");
    expect(init.output).toContain("without signing in");
    expect(init.output).not.toContain("--offline");
    expect(init.output).not.toContain("lax-0");
  });

  it("keeps the build iteration options discoverable", () => {
    const build = cli(["build", "--help"]);
    expect(build.output).toContain("--profile");
    expect(build.output).toContain("--only <part>");
    expect(build.output).toContain("--build-from-source");
    expect(build.output).toContain("--verbose");

    const register = cli(["register", "--help"]);
    expect(register.output).toContain("--yes");
  });

  it("carries the explicit source triple and --resume on `submit`", () => {
    const submit = cli(["submit", "--help"]);
    expect(submit.code).toBe(0);
    expect(submit.output).toContain("--resume");
    expect(submit.output).toContain("--repository <url>");
    expect(submit.output).toContain("--commit <sha>");
    expect(submit.output).toContain("--folder <path>");
    expect(submit.output).toContain("--allow-dirty");
    expect(submit.output).toContain("-f, --force");
  });

  it("refuses combinations that cannot mean anything on `submit`", () => {
    const halfTriple = cli(["submit", "lax-42", "--repository", "https://github.com/a/b"]);
    expect(halfTriple.code).toBe(1);
    expect(halfTriple.output).toContain("--repository and --commit must be given together");

    const resumePlus = cli(["submit", "--resume", "--allow-dirty"]);
    expect(resumePlus.code).toBe(1);
    expect(resumePlus.output).toContain("--resume takes no other options");

    const resumeForced = cli(["submit", "--resume", "-f"]);
    expect(resumeForced.code).toBe(1);
    expect(resumeForced.output).toContain("--resume takes no other options");

    const forcedTriple = cli([
      "submit",
      "lax-42",
      "--force",
      "--repository",
      "https://github.com/a/b",
      "--commit",
      "0".repeat(40),
    ]);
    expect(forcedTriple.code).toBe(1);
    expect(forcedTriple.output).toContain("--force applies to the Git-derived form");

    const strayFolder = cli(["submit", "--folder", "sub"]);
    expect(strayFolder.code).toBe(1);
    expect(strayFolder.output).toContain("--folder belongs to the explicit triple");
  });

  it("gives every meaning exactly one word", () => {
    // `lax update` is the CLI self-upgrade (spec.md's original meaning); the
    // source triple lives on `submit`, the archive refresh on `sync`.
    const update = cli(["update", "--help"]);
    expect(update.code).toBe(0);
    expect(update.output).toContain("upgrade lax to the latest release");

    const sync = cli(["sync", "--help"]);
    expect(sync.code).toBe(0);
    expect(sync.output).toContain("refresh your local copy of the archive");

    // The retired second names are gone rather than kept as aliases —
    // `pull-db` was the last command named after the machinery.
    for (const retired of ["set-owners", "update-db", "update-database", "pull-db", "spec"]) {
      const result = cli([retired]);
      expect(result.code, retired).not.toBe(0);
      expect(result.output, retired).toContain(`unknown command '${retired}'`);
    }
  });

  it("prints the bundled documents verbatim, for an agent to read", () => {
    const spec = cli(["print", "spec"]);
    expect(spec.code).toBe(0);
    expect(spec.output).toContain("After each successfully completed proof");
    expect(spec.output).toContain("lax serve path/to/submission");
    expect(spec.output).toContain("lax build path/to/submission");
    expect(spec.output).toContain("successfully validated milestone");

    const instructions = cli(["print", "instructions"]);
    expect(instructions.code).toBe(0);
    expect(instructions.output).toContain("lax print spec");
  });

  it("reports an error as an error, with no command-name prefix", () => {
    const result = cli(["build", "--only", "everything"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("✗ --only takes");
    expect(result.output).toContain("got `everything`");
    // rule 1: the author knows what they typed
    expect(result.output).not.toContain("lax build:");
  });

  it("requires explicit confirmation before non-interactive registration", () => {
    // an empty LAX_HOME keeps the register preflight off the developer's ~/.lax
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-home-"));
    try {
      const result = cli(["register", "lax-41"], { LAX_HOME: home });
      expect(result.code).toBe(1);
      expect(result.output).toContain("Registering is permanent");
      expect(result.output).toContain("There is no local copy of the archive");
      expect(result.output).toContain("registering lax-41 needs a confirmation");
      expect(result.output).toContain("Rerun with --yes");
      expect(result.output).not.toContain("no GitHub App login found");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("aggregates missing tools for the host build toolchain", () => {
    // An empty PATH is no longer enough to make elan and lake missing: the
    // preflight resolves them in the lax-owned locations first (doctor installs
    // elan with --no-modify-path, so on a provisioned machine neither is ever on
    // PATH). An ELAN_HOME that does not exist is what "no toolchain" means now.
    const result = cli(["build"], { PATH: "/nonexistent", ELAN_HOME: "/nonexistent/elan" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("lax needs tools it cannot find");
    expect(result.output).toContain("git:");
    expect(result.output).toContain("elan:");
    expect(result.output).toContain("lake:");
    expect(result.output).not.toContain("docker:");
    expect(result.output).toContain("lax doctor");
  });
});

function cli(
  args: string[],
  extraEnvironment: Record<string, string> = {},
): { code: number; output: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli/main.ts", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        LAX_DISABLE_UPDATE_CHECK: "1",
        // Assertions are about words, not about escape codes.
        NO_COLOR: "1",
        ...extraEnvironment,
      },
    },
  );
  return {
    code: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
  };
}
