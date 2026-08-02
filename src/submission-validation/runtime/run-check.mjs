import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [planPath] = process.argv.slice(2);
if (planPath === undefined || !path.isAbsolute(planPath)) process.exit(2);
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
if (!plan || !Array.isArray(plan.ownLibs) || !Array.isArray(plan.dependencyLibs) || !Array.isArray(plan.args)) process.exit(2);
const leanNumThreads = process.env.LEAN_NUM_THREADS;
if (leanNumThreads === undefined || !/^[1-9][0-9]*$/u.test(leanNumThreads)) process.exit(2);
const warmPackages = "/opt/lax-runtime/warm/.lake/packages";
const warmLibs = fs.readdirSync(warmPackages, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(warmPackages, entry.name, ".lake", "build", "lib", "lean"))
  .filter((entry) => fs.existsSync(entry));
const env = {
  PATH: `/opt/lean/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
  HOME: "/tmp/lax-check-home",
  LEAN_NUM_THREADS: leanNumThreads,
  LEAN_PATH: [...plan.ownLibs, ...plan.dependencyLibs, ...warmLibs].join(path.delimiter),
};
const executable = plan.tool === "replay" ? "/opt/lean/bin/leanchecker" : "/opt/lax-runtime/bin/laxinspector";
const result = spawnSync(executable, plan.args, {
  cwd: plan.cwd,
  env,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 8 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) process.stderr.write(`${plan.tool} failed to start: ${result.error.message}\n`);
if (result.signal) process.stderr.write(`${plan.tool} terminated by ${result.signal}\n`);
process.exit(result.status ?? 1);
