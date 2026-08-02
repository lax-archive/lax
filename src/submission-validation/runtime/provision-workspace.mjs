import fs from "node:fs";
import path from "node:path";

const [planPath] = process.argv.slice(2);
if (planPath === undefined || !path.isAbsolute(planPath)) process.exit(2);
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
if (plan.version !== 1 || !Array.isArray(plan.packages)) process.exit(2);
const warmRoot = "/opt/lax-runtime/warm";
const warmManifest = JSON.parse(fs.readFileSync(path.join(warmRoot, "lake-manifest.json"), "utf8"));
const warmPackages = path.join(warmRoot, ".lake", "packages");

for (const pkg of plan.packages) {
  if (!pkg || typeof pkg.directory !== "string" || !path.isAbsolute(pkg.directory)) process.exit(2);
  const packagesDir = path.join(pkg.directory, ".lake", "packages");
  fs.mkdirSync(packagesDir, { recursive: true });
  for (const entry of fs.readdirSync(warmPackages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(packagesDir, entry.name);
    if (!fs.existsSync(target)) fs.symlinkSync(path.join(warmPackages, entry.name), target);
  }
  const entries = [];
  for (const dependency of pkg.dependencies ?? []) {
    if (typeof dependency.name !== "string" || typeof dependency.directory !== "string") process.exit(2);
    entries.push({
      type: "path",
      scope: "",
      name: dependency.name,
      manifestFile: "lake-manifest.json",
      inherited: false,
      dir: dependency.directory,
      configFile: "lakefile.toml",
    });
  }
  for (const dependency of pkg.pathDependencies ?? []) {
    if (typeof dependency.name !== "string" || typeof dependency.directory !== "string") process.exit(2);
    entries.push({
      type: "path",
      scope: "",
      name: dependency.name,
      manifestFile: "lake-manifest.json",
      inherited: false,
      dir: dependency.directory,
      configFile: "lakefile.toml",
    });
  }
  entries.push(...warmManifest.packages);
  fs.writeFileSync(
    path.join(pkg.directory, "lake-manifest.json"),
    `${JSON.stringify({ version: "1.2.0", packagesDir: ".lake/packages", packages: entries }, null, 1)}\n`,
    { mode: 0o600 },
  );
}
