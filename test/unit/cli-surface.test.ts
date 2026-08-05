import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("CLI compatibility surface", () => {
  it("keeps the local workflow commands and build iteration options discoverable", () => {
    const help = cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.output).toContain("set-owners|owners");
    expect(help.output).toContain("update-db|pull-db");
    expect(help.output).toContain("serve [options]");
    expect(help.output).toContain("upgrade");

    const build = cli(["build", "--help"]);
    expect(build.output).toContain("--profile");
    expect(build.output).toContain("--only <part>");
    expect(build.output).toContain("--build-from-source");

    const register = cli(["register", "--help"]);
    expect(register.output).toContain("--yes");
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
    const result = cli(["register", "lax-42"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("registering lax-42 is permanent");
    expect(result.output).toContain("rerun with --yes");
    expect(result.output).not.toContain("no GitHub App login found");
  });

  it("aggregates missing tools for the host build toolchain", () => {
    const result = cli(["build"], { PATH: "/nonexistent" });
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
