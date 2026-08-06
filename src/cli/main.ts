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
  resumeSubmit,
  submitExplicitSource,
  submitFolder,
} from "./commands.js";
import { pullDatabase } from "./database.js";
import { doctor, installHint, toolVersion } from "./doctor.js";
import { login } from "./login.js";
import { printSpec } from "./spec.js";
import { updateCli } from "./update.js";
import { serveWebsite } from "./website.js";
import { checkForCliUpdate } from "./update-check.js";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
checkForCliUpdate(version);
const program = new Command()
  .name("lax")
  .description("the Lax archive CLI")
  .version(version);
program.addHelpText(
  "after",
  `
Typical workflow:
  lax init my-work                allocate an id and scaffold a submission
  lax build my-work               validate it locally
  lax serve my-work               preview the generated pages
  git commit && git push          publish the source commit
  lax submit my-work              submit it as a replaceable draft
  lax register my-work            register it: immutable and citable

\`lax doctor\` checks your setup; \`lax <command> --help\` shows command options.
`,
);

program
  .command("init")
  .argument("[folder]", "target folder", ".")
  .option("--title <title>", "submission title (defaults to the folder name)")
  .description("start a submission: allocate its id and scaffold the complete layout")
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
    "build mathlib from source when its prebuilt artifacts cannot be fetched",
  )
  .description("run the archive validation pipeline locally and write build-output.json")
  .action(
    run("lax build", (
      folder: string,
      options: { profile?: boolean; replay?: boolean; only?: string; buildFromSource?: boolean },
    ) => {
      if (options.only !== undefined && options.only !== "concepts" && options.only !== "proofs") {
        throw new Error(`--only takes \`concepts\` or \`proofs\`, got \`${options.only}\``);
      }
      preflight(["elan", "lake", "git"]);
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
  .command("owners")
  .argument("<target>", "submission folder or lax-N id")
  .requiredOption("--new-list <handles...>", "complete replacement list of GitHub handles")
  .description("replace the owner set of an init or draft submission")
  .action(run("lax owners", (target: string, options: { newList: string[] }) => replaceOwners(target, options.newList)));

program
  .command("submit")
  .argument("[folder]", "submission folder (with --repository: a lax-N id)", ".")
  .option("-f, --allow-dirty", "submit committed HEAD while excluding local changes")
  .option("--resume", "reattach to the submit already requested here")
  .option("--repository <url>", "public HTTPS GitHub repository URL of an explicit source")
  .option("--commit <sha>", "full commit SHA of an explicit source")
  .option("--folder <path>", "folder relative to the repository root (with --repository)")
  .description("submit the pushed commit to the archive as a replaceable draft")
  .action(
    run("lax submit", (
      folder: string,
      options: {
        allowDirty?: boolean;
        resume?: boolean;
        repository?: string;
        commit?: string;
        folder?: string;
      },
    ) => {
      const explicit = options.repository !== undefined || options.commit !== undefined;
      if (options.resume === true) {
        if (explicit || options.allowDirty === true) {
          throw new Error("--resume takes no other options: it reattaches to what was already sent");
        }
        return resumeSubmit(folder);
      }
      if (explicit) {
        if (options.repository === undefined || options.commit === undefined) {
          throw new Error("--repository and --commit must be given together");
        }
        if (options.allowDirty === true) {
          throw new Error("--allow-dirty applies to the Git-derived form, not an explicit triple");
        }
        return submitExplicitSource(folder, options.repository, options.commit, options.folder ?? ".");
      }
      if (options.folder !== undefined) {
        throw new Error("--folder belongs to the explicit triple; pass the folder as the argument");
      }
      preflight(["git"]);
      return submitFolder(folder, options.allowDirty ?? false);
    },
    ),
  );

program
  .command("delete")
  .argument("<target>", "submission folder or lax-N id")
  .option("--yes", "skip the irreversible-action confirmation prompt")
  .description("delete an init or draft submission — its id is retired, never reused")
  .action(
    run("lax delete", (target: string, options: { yes?: boolean }) =>
      requestDelete(target, options.yes ?? false),
    ),
  );

program
  .command("register")
  .argument("<target>", "submission folder or lax-N id")
  .option("--yes", "skip the irreversible-action confirmation prompt")
  .description("register an init or draft submission: immutable and citable")
  .action(run("lax register", (target: string, options: { yes?: boolean }) =>
    requestRegistration(target, options.yes ?? false)));

program
  .command("pull-db")
  .description("refresh the local database clone at ~/.lax/lax-database")
  .action(run("lax pull-db", async () => {
    preflight(["git"]);
    pullDatabase();
  }));

program
  .command("serve")
  .argument("[folder]", "local submission folder", ".")
  .option("--port <port>", "local preview port", "8123")
  .option("--database-only", "render only lax-database, without the local folder")
  .description("render the website locally and serve it for preview")
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
  .command("doctor")
  .description("check tools, login, and local state — with fixes")
  .action(run("lax doctor", doctor));

program
  .command("update")
  .alias("upgrade")
  .description("upgrade the CLI to the latest release, then refresh the local database")
  .action(run("lax update", () => {
    preflight(["npm", "git"]);
    return updateCli();
  }));

program.command("spec").description("print the specification this CLI enforces").action(printSpec);

program
  .command("login")
  .description("log in with your GitHub account (device flow — no configuration needed)")
  .action(run("lax login", login));
program
  .command("logout")
  .description("revoke and remove the login stored by `lax login`")
  .action(run("lax logout", async () => {
    console.log("Revoking any stored GitHub App credentials with GitHub.");
    console.log(
      (await logout())
        ? "Revoked the GitHub App credentials and logged out."
        : "No stored login was present.",
    );
  }));

program.parseAsync(process.argv).catch((error: unknown) => {
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
