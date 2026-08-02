import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import type { ResolutionResult, StaticResult } from "../contracts.js";
import type { FetchedSource } from "../source/fetch.js";
import type { ContainerMount, ContainerRunner } from "../sandbox/container.js";
import { flattenClosure, type SiblingGraph } from "./siblings.js";

export interface ProvisionedWorkspace {
  repositoryRoot: string;
  submissionRoot: string;
  containerSubmissionRoot: string;
  manifests: Record<"concepts" | "proofs", string>;
  libraries: Record<"concepts" | "proofs", string>;
  buildMounts: Record<"concepts" | "proofs", ContainerMount[]>;
}

interface ProvisionPlan {
  version: 1;
  packages: Array<{
    directory: string;
    dependencies: Array<{ name: string; directory: string }>;
    pathDependencies: Array<{ name: string; directory: string }>;
  }>;
}

export async function provisionWorkspace(
  label: string,
  fetched: FetchedSource,
  sourceFolder: string,
  staticResult: StaticResult,
  resolution: ResolutionResult,
  siblings: SiblingGraph,
  jobDir: string,
  dependencyRoot: string,
  runner: ContainerRunner,
  limits: ValidationLimits,
): Promise<ProvisionedWorkspace> {
  const repositoryRoot = path.join(jobDir, "workspaces", label, "repository");
  fs.mkdirSync(path.dirname(repositoryRoot), { recursive: true, mode: 0o700 });
  fs.cpSync(fetched.repositoryRoot, repositoryRoot, {
    recursive: true,
    dereference: false,
    filter: (filename) => {
      const relative = path.relative(fetched.repositoryRoot, filename);
      if (relative === "") return true;
      const parts = relative.split(path.sep);
      return !parts.includes(".git") && !parts.includes(".lake");
    },
  });
  const submissionRoot = sourceFolder === "." ? repositoryRoot : path.join(repositoryRoot, sourceFolder);
  const containerSubmission = sourceFolder === "." ? "/work/repository" : `/work/repository/${sourceFolder}`;
  const siblingNames = new Set(siblings.closure.keys());
  const packages = (["concepts", "proofs"] as const).flatMap((kind) => {
    const staticPackage = staticResult[kind];
    if (staticPackage === undefined) return [];
    const flattened = flattenClosure(path.join(submissionRoot, kind), siblings.closure);
    const pathDependencies = new Map<string, string>();
    for (const dependency of staticPackage.lakefile.pathRequires)
      pathDependencies.set(dependency.name, dependency.path);
    for (const dependency of flattened.pathDeps)
      pathDependencies.set(dependency.name, dependency.dir);
    if (kind === "proofs" && staticPackage.lakefile.hasConceptPathRequire && staticResult.concepts !== undefined) {
      pathDependencies.set(staticResult.concepts.lakefile.packageName, "../concepts");
    }
    const dependencies = dependencyClosure(kind, resolution)
      .filter((dependency) => !siblingNames.has(dependency.packageName));
    return [{
      directory: `${containerSubmission}/${kind}`,
      dependencies: dependencies.map((dependency) => ({
        name: dependency.packageName,
        directory: `/deps/${dependency.submissionId}/${dependency.kind}/package`,
      })),
      pathDependencies: [...pathDependencies].map(([name, directory]) => ({ name, directory })),
    }];
  });
  const plan: ProvisionPlan = { version: 1, packages };
  const planPath = path.join(repositoryRoot, ".lax-provision.json");
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  const result = await runner.run({
    label: `provision-${label}`,
    args: ["node", "/opt/lax-runtime/bin/provision-workspace.mjs", "/work/repository/.lax-provision.json"],
    mounts: [
      { source: path.join(jobDir, "workspaces", label), target: "/work", writable: true },
      ...(fs.existsSync(dependencyRoot) ? [{ source: dependencyRoot, target: "/deps" }] : []),
    ],
    timeoutMs: 60_000,
    maxOutputBytes: limits.maxOutputBytes,
  });
  fs.rmSync(planPath, { force: true });
  if (result.code !== 0) throw new Error(`workspace provisioning failed: ${result.output.trim()}`);
  const manifests = Object.fromEntries(
    (["concepts", "proofs"] as const).map((kind) => {
      const filename = path.join(submissionRoot, kind, "lake-manifest.json");
      const stat = fs.statSync(filename);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
        throw new Error(`trusted provisioning did not produce a bounded ${kind} manifest`);
      return [kind, fs.readFileSync(filename, "utf8")];
    }),
  ) as Record<"concepts" | "proofs", string>;
  const isolated = isolateBuildDirectories(
    path.join(jobDir, "workspaces", label),
    fetched.repositoryRoot,
    repositoryRoot,
    submissionRoot,
    siblings,
  );
  return {
    repositoryRoot,
    submissionRoot,
    containerSubmissionRoot: sourceFolder === "." ? "/source" : `/source/${sourceFolder}`,
    manifests,
    ...isolated,
  };
}

function isolateBuildDirectories(
  workspaceRoot: string,
  fetchedRepositoryRoot: string,
  repositoryRoot: string,
  submissionRoot: string,
  siblings: SiblingGraph,
): Pick<ProvisionedWorkspace, "libraries" | "buildMounts"> {
  const ownDirectories = {
    concepts: path.join(submissionRoot, "concepts"),
    proofs: path.join(submissionRoot, "proofs"),
  };
  const siblingDirectories = [...new Set([...siblings.closure.values()].map((entry) => {
    const relative = path.relative(fetchedRepositoryRoot, entry.pkgDir);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("sibling package escaped the provisioned repository");
    return path.join(repositoryRoot, relative);
  }))];
  const buildRoots = new Map<string, string>();
  for (const packageDirectory of [...Object.values(ownDirectories), ...siblingDirectories]) {
    const relative = path.relative(repositoryRoot, packageDirectory);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("package build directory escaped the provisioned repository");
    const sourceLake = path.join(packageDirectory, ".lake");
    const buildLake = path.join(workspaceRoot, "build", relative, ".lake");
    fs.mkdirSync(path.dirname(buildLake), { recursive: true, mode: 0o700 });
    if (fs.existsSync(sourceLake)) fs.renameSync(sourceLake, buildLake);
    else fs.mkdirSync(buildLake, { recursive: true, mode: 0o700 });
    // Keep an empty mount point in the read-only repository. Compilation sees
    // the external directory through a nested bind mount at this path.
    fs.mkdirSync(sourceLake, { recursive: true, mode: 0o700 });
    buildRoots.set(packageDirectory, buildLake);
  }
  const libraries = {
    concepts: path.join(buildRoots.get(ownDirectories.concepts)!, "build", "lib", "lean"),
    proofs: path.join(buildRoots.get(ownDirectories.proofs)!, "build", "lib", "lean"),
  };
  fs.mkdirSync(libraries.concepts, { recursive: true, mode: 0o700 });
  fs.mkdirSync(libraries.proofs, { recursive: true, mode: 0o700 });
  const mount = (packageDirectory: string): ContainerMount => ({
    source: buildRoots.get(packageDirectory)!,
    target: `/source/${path.relative(repositoryRoot, packageDirectory).split(path.sep).join("/")}/.lake`,
    writable: true,
  });
  const siblingMounts = siblingDirectories.map(mount);
  const conceptMount = mount(ownDirectories.concepts);
  return {
    libraries,
    buildMounts: {
      concepts: [conceptMount, ...siblingMounts],
      proofs: [
        conceptMount,
        mount(ownDirectories.proofs),
        ...siblingMounts,
        {
          source: libraries.concepts,
          target: `${conceptMount.target}/build/lib/lean`,
        },
      ],
    },
  };
}

function dependencyClosure(
  kind: "concepts" | "proofs",
  resolution: ResolutionResult,
): ResolutionResult["all"] {
  const byName = new Map(resolution.all.map((dependency) => [dependency.packageName, dependency]));
  const result = new Map<string, ResolutionResult["all"][number]>();
  const visit = (name: string): void => {
    const dependency = byName.get(name);
    if (dependency === undefined || result.has(name)) return;
    result.set(name, dependency);
    dependency.requiredPackages.forEach(visit);
    if (dependency.kind === "proofs") visit(name.slice(0, -"Proofs".length));
  };
  (kind === "concepts" ? resolution.concepts : resolution.proofs)
    .forEach((dependency) => visit(dependency.packageName));
  return [...result.values()].sort((a, b) => a.packageName.localeCompare(b.packageName));
}

export function installOwnConceptCapture(workspace: ProvisionedWorkspace, captureRoot: string): void {
  const source = path.join(captureRoot, "concepts", "lib");
  const destination = workspace.libraries.concepts;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
  const now = new Date();
  touch(destination, now);
  makeFilesReadOnly(destination);
}

function touch(directory: string, time: Date): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) touch(filename, time);
    else if (entry.isFile()) fs.utimesSync(filename, time, time);
  }
}

function makeFilesReadOnly(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) makeFilesReadOnly(filename);
    else if (entry.isFile()) fs.chmodSync(filename, 0o444);
  }
}
