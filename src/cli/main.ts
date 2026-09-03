import { createRequire } from "node:module";
import { Command } from "commander";
import type { ValidationScope } from "../submission-validation/contracts.js";
import { logout } from "./auth.js";
import { buildSubmission } from "./build.js";
import {
  initializeSubmission,
  replaceOwners,
  requestDelete,
  requestRegistration,
  requestUpdate,
  submitFolder,
} from "./commands.js";
import { updateDatabase } from "./database.js";
import { doctor, installHint, toolVersion } from "./doctor.js";
import { login } from "./login.js";
import { printSpec } from "./spec.js";
import { upgradeCli } from "./upgrade.js";
import { serveWebsite } from "./website.js";
import { checkForCliUpdate } from "./update-check.js";
import { generateProofTree } from "./prooftree.js";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
checkForCliUpdate(version);
const program = new Command()
  .name("lax")
  .description("the Lax archive CLI (backed by GitHub issues and Actions)")
  .version(version);
program.addHelpText(
  "after",
  `
Typical workflow:
  lax init my-work --title "My formalization"   scaffold locally without a GitHub login
  lax set-owners my-work --new-list alice bob    optionally record provisional owners
  lax build my-work                              validate the local submission
  lax serve my-work                              preview it with the current Website renderer
  git commit && git push                         publish an immutable source commit
  lax submit my-work                             reserve its issue on first use; import on the next
  lax register my-work                           make the accepted record immutable

\`lax doctor\` checks your setup; \`lax <command> --help\` shows command options.
`,
);

program
  .command("init")
  .argument("[folder]", "target folder", ".")
  .option("--title <title>", "submission title (defaults to the folder name)")
  .description("generate a six-digit id and scaffold locally without GitHub authentication")
  .action(
    run("lax init", (folder: string, options: { title?: string }) =>
      initializeSubmission(folder, options.title),
    ),
  );

program
  .command("build")
  .argument("[folder]", "submission folder", ".")
  .option("--profile", "print phase timings")
  .option("--replay", "also run the kernel replay used by the trusted workflow")
  .option("--only <part>", "build only `concepts` or `proofs` for fast iteration")
  .option(
    "--build-from-source",
    "build the pinned validation runtime locally when no published image is available",
  )
  .description("run the shared validation pipeline locally and write build-output.json")
  .action(
    run("lax build", (
      folder: string,
      options: { profile?: boolean; replay?: boolean; only?: string; buildFromSource?: boolean },
    ) => {
      if (options.only !== undefined && options.only !== "concepts" && options.only !== "proofs") {
        throw new Error(`--only takes \`concepts\` or \`proofs\`, got \`${options.only}\``);
      }
      preflight(["git", "docker"]);
      return buildSubmission(folder, {
        profile: options.profile,
        replay: options.replay,
        scope: (options.only as ValidationScope | undefined) ?? "both",
        buildFromSource: options.buildFromSource,
      });
    },
    ),
  );

program
  .command("set-owners")
  .alias("owners")
  .argument("<target>", "submission folder, id, or legacy issue reference")
  .requiredOption("--new-list <handles...>", "complete replacement list of GitHub handles")
  .description("store provisional local owners or replace a bound submission's owner set")
  .action(run("lax set-owners", (target: string, options: { newList: string[] }) => replaceOwners(target, options.newList)));

program
  .command("update")
  .argument("<target>", "submission folder (or a legacy issue reference)")
  .requiredOption("--repository <url>", "canonical public HTTPS URL on a supported Git host")
  .requiredOption("--commit <sha>", "full immutable lowercase commit SHA")
  .option("--folder <path>", "submission folder relative to repository root", ".")
  .description("submit an explicit source triple to the issue-backed validation workflow")
  .action(
    run(
      "lax update",
      (
        target: string,
        options: { repository: string; commit: string; folder: string },
      ) => requestUpdate(target, options.repository, options.commit, options.folder),
    ),
  );

program
  .command("submit")
  .argument("[folder]", "submission folder", ".")
  .option("-f, --allow-dirty", "submit committed HEAD while excluding local changes")
  .description("derive the source triple from Git and request an issue-backed import")
  .action(
    run("lax submit", (folder: string, options: { allowDirty?: boolean }) => {
      preflight(["git"]);
      return submitFolder(folder, options.allowDirty ?? false);
    },
    ),
  );

program
  .command("delete")
  .argument("<target>", "submission folder, id, or legacy issue reference")
  .option("--yes", "skip the irreversible-action confirmation prompt")
  .description("permanently retire an init or draft submission")
  .action(
    run("lax delete", (target: string, options: { yes?: boolean }) =>
      requestDelete(target, options.yes ?? false),
    ),
  );

program
  .command("register")
  .argument("<target>", "submission folder, id, or legacy issue reference")
  .option("--yes", "skip the irreversible-action confirmation prompt")
  .description("make an init or draft Archive record immutable")
  .action(run("lax register", (target: string, options: { yes?: boolean }) =>
    requestRegistration(target, options.yes ?? false)));

program
  .command("update-db")
  .aliases(["pull-db", "update-database"])
  .description("clone or fast-forward ~/.lax/lax-database from lax-archive/lax-database")
  .action(run("lax update-db", async () => {
    preflight(["git"]);
    updateDatabase();
  }));

program
  .command("serve")
  .argument("[folder]", "local submission folder", ".")
  .option("--port <port>", "local preview port", "8123")
  .option("--database-only", "render only lax-database, without the local folder")
  .description("build the website with the current lax-website renderer and serve it locally")
  .action(
    run(
      "lax serve",
      (
        folder: string,
        options: { port: string; databaseOnly?: boolean },
      ) => serveWebsite(folder, Number(options.port), { databaseOnly: options.databaseOnly }),
    ),
  );

program
  .command("generate-prooftree")
  .argument("<submission>", "lax-N submission id")
  .option("--output <folder>", "output folder (defaults to ./prooftree-lax-N)")
  .description("compose a kernel-checked proof tree for every statement of a submission")
  .action(
    run("lax generate-prooftree", (
      submission: string,
      options: { output?: string },
    ) => {
      preflight(["git", "lean", "lake", "tar"]);
      return generateProofTree(submission, { output: options.output });
    }),
  );

program
  .command("doctor")
  .description("check local tools, GitHub login, validation runtime, database, and Website renderer")
  .action(run("lax doctor", doctor));

program
  .command("upgrade")
  .description("upgrade the CLI, database, and Website renderer")
  .action(run("lax upgrade", () => {
    preflight(["npm", "git"]);
    return upgradeCli();
  }));

program.command("spec").description("print the specification this CLI enforces").action(printSpec);

program
  .command("login")
  .description("authenticate through the Lax GitHub App device flow")
  .action(run("lax login", login));
program
  .command("logout")
  .description("revoke the stored GitHub App login and remove its credentials")
  .action(run("lax logout", async () => {
    console.log(
      (await logout())
        ? "Revoked the GitHub App credentials and logged out."
        : "No stored login was present.",
    );
  }));

await program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`lax: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

function run<T extends unknown[]>(
  command: string,
  action: (...args: T) => Promise<void | number>,
): (...args: T) => Promise<void> {
  return async (...args: T): Promise<void> => {
    try {
      const result = await action(...args);
      if (typeof result === "number") process.exitCode = result;
    } catch (error) {
      console.error(`${command}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  };
}

function preflight(tools: string[]): void {
  const missing = [...new Set(tools)].filter((tool) => toolVersion(tool) === undefined);
  if (missing.length === 0) return;
  throw new Error(
    `missing required tools:\n${missing.map((tool) => `  - ${tool}: ${installHint(tool)}`).join("\n")}\n` +
      "run `lax doctor` for a complete environment check",
  );
}
