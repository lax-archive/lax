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


  it("keeps the local workflow commands and build iteration options discoverable", () => {
    const help = cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.output).toContain("owners");
    expect(help.output).toContain("pull-db");
    expect(help.output).toContain("serve [options]");
    expect(help.output).toContain("update|upgrade");

    const build = cli(["build", "--help"]);
    expect(build.output).toContain("--profile");
    expect(build.output).toContain("--only <part>");
    expect(build.output).toContain("--build-from-source");

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
    // `lax update` is the CLI self-upgrade again (spec.md's original meaning);
    // the source triple lives on `submit`, the database refresh on `pull-db`.
    const update = cli(["update", "--help"]);
    expect(update.code).toBe(0);
    expect(update.output).toContain("upgrade the CLI to the latest release");

    const pull = cli(["pull-db", "--help"]);
    expect(pull.code).toBe(0);
    expect(pull.output).toContain("~/.lax/lax-database");

    // The retired second names are gone rather than kept as aliases.
    for (const retired of ["set-owners", "update-db", "update-database"]) {
      const result = cli([retired]);
      expect(result.code, retired).not.toBe(0);
      expect(result.output, retired).toContain(`unknown command '${retired}'`);
    }
  });

  it("prints the continuous proof-preview workflow in the bundled specification", () => {
    const spec = cli(["spec"]);
    expect(spec.code).toBe(0);
    expect(spec.output).toContain("After each successfully completed proof");
    expect(spec.output).toContain("lax serve path/to/submission");
    expect(spec.output).toContain("lax build path/to/submission");
    expect(spec.output).toContain("successfully validated milestone");
  });

  it("uses command-specific errors", () => {
    const result = cli(["build", "--only", "everything"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("lax build: --only takes");
    expect(result.output).not.toContain("lax: --only takes");
  });

  it("requires explicit confirmation before non-interactive registration", () => {
    // an empty LAX_HOME keeps the register preflight off the developer's ~/.lax
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-home-"));
    try {
      const result = cli(["register", "lax-42"], { LAX_HOME: home });
      expect(result.code).toBe(1);
      expect(result.output).toContain("no local lax-database checkout");
      expect(result.output).toContain("registering lax-42 is permanent");
      expect(result.output).toContain("rerun with --yes");
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
    expect(result.output).toContain("missing required tools");
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
        ...extraEnvironment,
      },
    },
  );
  return {
    code: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
  };
}
