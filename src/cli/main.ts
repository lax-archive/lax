import { createRequire } from "node:module";
import { Command, Help } from "commander";
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
import { syncDatabase } from "./database.js";
import { doctor, installHint, toolVersion } from "./doctor.js";
import { CommandFailedError } from "./follow.js";
import { login } from "./login.js";
import { printInstructions, printSpec } from "./spec.js";
import * as ui from "./ui.js";
import { updateCli } from "./update.js";
import { serveWebsite } from "./website.js";
import { checkForCliUpdate } from "./update-check.js";
import { generateProofTree } from "./prooftree.js";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
// The background release probe caches its result in ~/.lax/update-check.json,
// which is a write — and `lax doctor --dry` promises there are none. Commander
// has not parsed anything yet, so this reads argv directly rather than moving
// the probe behind the parse, where every command would have to remember it.
const argv = process.argv.slice(2);
if (!(argv.includes("doctor") && argv.includes("--dry"))) checkForCliUpdate(version);
const program = new Command()
  .name("lax")
  .description("the archive for machine-checked mathematics")
  .version(version);

/**
 * The curated command list, in the order an author meets them, replacing
 * commander's alphabetical dump of every flag. `lax <command> --help` is still
 * commander's own, which is where the options belong.
 */
const overview = (): string => `
  ${ui.bold("lax")} — the archive for machine-checked mathematics

  Getting started
    ${ui.cmd("lax doctor")}            check your setup
    ${ui.cmd("lax login")}             sign in with GitHub

  Making a submission
    ${ui.cmd("lax init my-work")}      reserve an id and set up the folder
    ${ui.cmd("lax build my-work")}     check it on your machine
    ${ui.cmd("lax serve my-work")}     preview the pages
    ${ui.cmd("lax submit my-work")}    send it to the archive as a draft
    ${ui.cmd("lax register my-work")}  make it permanent and citable

  Also
    lax owners · lax delete · lax sync · lax update · lax logout
    lax print spec · lax print instructions

  ${ui.dim("lax <command> --help for options")}
`;

const formatHelp = Help.prototype.formatHelp;
program.configureHelp({
  formatHelp: (command, helper) =>
    command === program ? overview() : formatHelp.call(helper, command, helper),
});

program
  .command("init")
  .argument("[folder]", "target folder", ".")
  .option("--title <title>", "submission title (defaults to the folder name)")
  .option("--offline", "set up the folder under the placeholder id lax-0, reserving nothing")
  .description("start a submission: reserve its id and set up the folder")
  .action(
    run((folder: string, options: { title?: string; offline?: boolean }) =>
      initializeSubmission(folder, { title: options.title, offline: options.offline }),
    ),
  );

program
  .command("build")
  .argument("[folder]", "submission folder", ".")
  .option("--profile", "print phase timings")
  .option("--replay", "also run the kernel replay the archive runs")
  .option("--only <part>", "build only `concepts` or `proofs` for fast iteration")
  .option(
    "--build-from-source",
    "build mathlib from source when its prebuilt artifacts cannot be fetched",
  )
  .description("run the archive's checks on your machine")
  .action(
    run(async (
      folder: string,
      options: { profile?: boolean; replay?: boolean; only?: string; buildFromSource?: boolean },
    ) => {
      if (options.only !== undefined && options.only !== "concepts" && options.only !== "proofs") {
        throw new Error(`--only takes \`concepts\` or \`proofs\`, got \`${options.only}\``);
      }
      preflight(["elan", "lake", "git"]);
      const outcome = await buildSubmission(folder, {
        profile: options.profile,
        replay: options.replay,
        scope: (options.only as ValidationScope | undefined) ?? "both",
        buildFromSource: options.buildFromSource,
      });
      return outcome.ok ? 0 : 1;
    },
    ),
  );

program
  .command("owners")
  .argument("<target>", "submission folder or lax-N id")
  .requiredOption("--new-list <handles...>", "complete replacement list of GitHub handles")
  .description("replace the owner set of an init or draft submission")
  .action(run((target: string, options: { newList: string[] }) => replaceOwners(target, options.newList)));

program
  .command("submit")
  .argument("[folder]", "submission folder (with --repository: a lax-N id)", ".")
  .option("-f, --force", "submit with no local checks at all — the archive is the only verdict")
  .option("--allow-dirty", "submit committed HEAD while excluding local changes")
  .option("--resume", "reattach to the submit already requested here")
  .option("--repository <url>", "public HTTPS repository URL of an explicit source")
  .option("--commit <sha>", "full commit SHA of an explicit source")
  .option("--folder <path>", "folder relative to the repository root (with --repository)")
  .description("send the pushed commit to the archive as a replaceable draft")
  .action(
    run((
      folder: string,
      options: {
        allowDirty?: boolean;
        force?: boolean;
        resume?: boolean;
        repository?: string;
        commit?: string;
        folder?: string;
      },
    ) => {
      const explicit = options.repository !== undefined || options.commit !== undefined;
      if (options.resume === true) {
        if (explicit || options.allowDirty === true || options.force === true) {
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
        // The explicit triple already skips every local check, so --force there
        // would be a word for the default: refuse it rather than imply it did
        // something.
        if (options.force === true) {
          throw new Error("--force applies to the Git-derived form; an explicit triple never builds locally");
        }
        return submitExplicitSource(folder, options.repository, options.commit, options.folder ?? ".");
      }
      if (options.folder !== undefined) {
        throw new Error("--folder belongs to the explicit triple; pass the folder as the argument");
      }
      preflight(["git"]);
      return submitFolder(folder, { allowDirty: options.allowDirty, force: options.force });
    },
    ),
  );

program
  .command("delete")
  .argument("<target>", "submission folder or lax-N id")
  .option("--yes", "skip the irreversible-action confirmation prompt")
  .description("delete an init or draft submission — its id is retired, never reused")
  .action(
    run((target: string, options: { yes?: boolean }) =>
      requestDelete(target, options.yes ?? false),
    ),
  );

program
  .command("register")
  .argument("<target>", "submission folder or lax-N id")
  .option("--yes", "skip the irreversible-action confirmation prompt")
  .description("make a submission permanent and citable")
  .action(run((target: string, options: { yes?: boolean }) =>
    requestRegistration(target, options.yes ?? false)));

program
  .command("sync")
  .description("refresh your local copy of the archive")
  .action(run(async () => {
    preflight(["git"]);
    await syncDatabase();
  }));

program
  .command("serve")
  .argument("[folder]", "local submission folder", ".")
  .option("--port <port>", "local preview port", "8123")
  .option("--database-only", "render only the archive, without the local folder")
  .description("preview the pages this submission generates")
  .action(
    run(
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
    run((
      submission: string,
      options: { output?: string },
    ) => {
      preflight(["git", "lean", "lake", "tar"]);
      return generateProofTree(submission, { output: options.output });
    }),
  );

program
  .command("doctor")
  .option("--dry", "report only: install nothing, refresh nothing, write nothing")
  .description("check your setup, with fixes")
  .action(run((options: { dry?: boolean }) => doctor({ dry: options.dry === true })));

program
  .command("update")
  .alias("upgrade")
  .description("upgrade lax to the latest release, then refresh the archive and Website renderer")
  .action(run(() => {
    preflight(["npm", "git"]);
    return updateCli();
  }));

// `lax print <document>`: verbatim document output, for an agent to read rather
// than for a terminal to look at — so these are the one pair of commands that
// deliberately does not go through `ui`.
const print = program.command("print").description("print a bundled document");
print
  .command("spec")
  .description("the specification this CLI enforces")
  .action(() => { printSpec(); });
print
  .command("instructions")
  .description("how to drive lax when formalizing a result")
  .action(() => { printInstructions(); });

program
  .command("login")
  .description("sign in with your GitHub account")
  .action(run(login));
program
  .command("logout")
  .description("revoke and remove the login stored by `lax login`")
  .action(run(async () => {
    const steps = new ui.Steps();
    steps.add("logout", "Signing out");
    try {
      const had = await logout();
      if (!had) {
        steps.settle("logout", { hidden: true });
        steps.finish();
        ui.line("Nothing to sign out of.");
        return;
      }
      steps.settle("logout", { label: "Signed out", time: false });
    } finally {
      steps.finish();
    }
  }));

// Every command carries the two options that only change how it speaks, so
// `lax build -v` and `lax -v build` both work and neither has to be remembered
// per command.
for (const command of allCommands(program)) {
  command
    .option("-v, --verbose", "also print run ids, URLs, and the tools' own transcripts")
    .option("--no-color", "plain text, with no colour");
}
program.hook("preAction", (_root, actionCommand) => {
  const root = program.opts() as { verbose?: boolean; color?: boolean };
  const own = actionCommand.opts() as { verbose?: boolean; color?: boolean };
  ui.configure({
    verbose: root.verbose === true || own.verbose === true,
    color: root.color !== false && own.color !== false,
  });
});

program.parseAsync(process.argv).catch((error: unknown) => {
  fail(error);
});

function allCommands(root: Command): Command[] {
  return [root, ...root.commands.flatMap((command) => allCommands(command))];
}

function run<T extends unknown[]>(
  action: (...args: T) => Promise<void | number>,
): (...args: T) => Promise<void> {
  return async (...args: T): Promise<void> => {
    try {
      const result = await action(...args);
      if (typeof result === "number") process.exitCode = result;
    } catch (error) {
      fail(error);
    }
  };
}

/**
 * A command that already printed its own report says nothing more here: the
 * archive's refusal, a failed build's findings, and the verdict above them are
 * the answer, and repeating the reason as a `✗` line would be the third time
 * the author read it. Everything else is an error with no report behind it.
 */
function fail(error: unknown): void {
  if (!(error instanceof CommandFailedError)) {
    ui.failure(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}

function preflight(tools: string[]): void {
  const missing = [...new Set(tools)].filter((tool) => toolVersion(tool) === undefined);
  if (missing.length === 0) return;
  throw new Error(
    `lax needs ${missing.length === 1 ? "a tool" : "tools"} it cannot find:\n` +
      `${missing.map((tool) => `${tool}: ${installHint(tool)}`).join("\n")}\n` +
      `run ${ui.cmd("lax doctor")} for a complete check of your setup`,
  );
}
