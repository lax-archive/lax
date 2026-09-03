import fs from "node:fs";
import path from "node:path";
import type { FindingCollector } from "../findings.js";

/** Reject undeclared files that could otherwise become package build inputs. */
export function checkPackageFiles(
  packageDir: string,
  kind: "concepts" | "proofs",
  packageName: string,
  findings: FindingCollector,
): void {
  if (!fs.existsSync(packageDir)) return;
  const allowedRoot = new Set(["lakefile.toml", "lean-toolchain", "lake-manifest.json", `${packageName}.lean`]);
  for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
    if (entry.name === ".lake") {
      if (!entry.isDirectory()) findings.violate("unexpected-files", `${kind}/.lake must be a directory`);
      continue;
    }
    const relative = `${kind}/${entry.name}`;
    if (entry.name === packageName) {
      if (!entry.isDirectory()) findings.violate("unexpected-files", `${relative} must be a directory`);
      else checkModuleTree(path.join(packageDir, entry.name), relative, findings);
    } else if (!allowedRoot.has(entry.name)) {
      findings.violate("unexpected-files", `unexpected package file: ${relative}`);
    } else if (!entry.isFile()) {
      findings.violate("unexpected-files", `${relative} must be a regular file`);
    }
  }
}

/** Copy only declared Lake and Lean inputs; generated and auxiliary files are omitted. */
export function copyPackageInputs(source: string, destination: string, packageName: string): void {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ["lakefile.toml", "lean-toolchain", `${packageName}.lean`]) {
    const filename = path.join(source, name);
    if (fs.existsSync(filename)) fs.cpSync(filename, path.join(destination, name), { dereference: false });
  }
  const modules = path.join(source, packageName);
  if (fs.existsSync(modules)) {
    fs.cpSync(modules, path.join(destination, packageName), {
      recursive: true,
      dereference: false,
      filter: (filename) => {
        if (filename === modules) return true;
        const entry = fs.lstatSync(filename);
        return entry.isDirectory() || (entry.isFile() && filename.endsWith(".lean"));
      },
    });
  }
}

function checkModuleTree(directory: string, relative: string, findings: FindingCollector): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const childRelative = `${relative}/${entry.name}`;
    if (entry.isDirectory()) checkModuleTree(child, childRelative, findings);
    else if (!entry.isFile() || !entry.name.endsWith(".lean"))
      findings.violate("unexpected-files", `unexpected package file: ${childRelative}`);
  }
}
