import fs from "node:fs";
import path from "node:path";
import { RUNTIME_PATHS } from "../config.js";
import type { ResolutionResult, StaticResult } from "../contracts.js";
import type { FetchedSource } from "../source/fetch.js";
import type { ContainerMount } from "../sandbox/container.js";
import { seedManifest, seedOverrides } from "../host/warmstore.js";

export interface ProvisionedWorkspace {
  repositoryRoot: string;
  submissionRoot: string;
  containerSubmissionRoot: string;
  manifests: Record<"concepts" | "proofs", string>;
  libraries: Record<"concepts" | "proofs", string>;
  buildMounts: Record<"concepts" | "proofs", ContainerMount[]>;
}

/**
 * Provision a build workspace on the host, before any container starts: copy
 * the fetched checkout, then seed each package's complete `lake-manifest.json`
 * and `.lake/package-overrides.json` from the warm workspace — the same
 * seedManifest/seedOverrides the local host build uses (see
 * host/warmstore.ts for why lake then resolves nothing, fetches nothing, and
 * never runs a post_update hook). The one difference is the base path: the
 * override `dir`s must be the IN-CONTAINER warm mount, because `lake build`
 * later runs inside the sandbox where the warm store appears at
 * RUNTIME_PATHS.warmWorkspace.
 */
export function provisionWorkspace(
  label: string,
  fetched: FetchedSource,
  sourceFolder: string,
  staticResult: StaticResult,
  resolution: ResolutionResult,
  jobDir: string,
  warmWs: string,
): ProvisionedWorkspace {
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
  for (const kind of ["concepts", "proofs"] as const) {
    const staticPackage = staticResult[kind];
    if (staticPackage === undefined) continue;
    // The proof package's own concept package is the only in-tree path
    // dependency there is; everything else is a rev-pinned require resolved
    // to a published capture.
    const ownConcepts =
      kind === "proofs" && staticPackage.lakefile.hasConceptPathRequire && staticResult.concepts !== undefined
        ? [{ name: staticResult.concepts.lakefile.packageName, dir: "../concepts" }]
        : [];
    const pkgDir = path.join(submissionRoot, kind);
    seedManifest(warmWs, pkgDir, [
      // required submissions materialize from their published captures at the
      // read-only /deps mount; their manifest dirs are container-absolute
      ...dependencyClosure(kind, resolution).map((dependency) => ({
        name: dependency.packageName,
        dir: `/deps/${dependency.submissionId}/${dependency.kind}/package`,
      })),
      ...ownConcepts,
    ]);
    seedOverrides(warmWs, pkgDir, RUNTIME_PATHS.warmWorkspace);
  }
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
    repositoryRoot,
    submissionRoot,
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
  repositoryRoot: string,
  submissionRoot: string,
): Pick<ProvisionedWorkspace, "libraries" | "buildMounts"> {
  const ownDirectories = {
    concepts: path.join(submissionRoot, "concepts"),
    proofs: path.join(submissionRoot, "proofs"),
  };
  const buildRoots = new Map<string, string>();
  for (const packageDirectory of Object.values(ownDirectories)) {
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
  const conceptMount = mount(ownDirectories.concepts);
  return {
    libraries,
    buildMounts: {
      concepts: [conceptMount],
      // Lake may refresh dependency traces or replace stale outputs while
      // compiling proofs, so the private concepts .lake mount must remain
      // writable as a whole. The separately captured concepts artifacts are
      // never mounted here; Replay later authenticates proofs against them.
      proofs: [conceptMount, mount(ownDirectories.proofs)],
    },
  };
}

/** The (transitive) resolved dependencies a package build needs on hand,
 * shared by container provisioning and the host pipeline. */
export function dependencyClosure(
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
  const now = new Date();
  // Install the full recorded output set, not just lib: lake judges a path
  // dependency's freshness from the trace plus every companion including the
  // C artifacts under build/ir (see the capture rationale in captures/seal.ts
  // and the ir handling in captures/materialize.ts). With ir missing, the
  // proofs build tries to rebuild the read-only concept modules and fails.
  const trees: Array<[string, string]> = [
    [path.join(captureRoot, "concepts", "lib"), workspace.libraries.concepts],
    [path.join(captureRoot, "concepts", "ir"), path.resolve(workspace.libraries.concepts, "..", "..", "ir")],
  ];
  for (const [source, destination] of trees) {
    fs.rmSync(destination, { recursive: true, force: true });
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(destination, { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
    touch(destination, now);
    makeFilesReadOnly(destination);
  }
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
