import fs from "node:fs";
import path from "node:path";
import type { ModuleInventory } from "../contracts.js";
import type { FindingCollector } from "../findings.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_']*$/u;

export function deriveInventory(
  submissionRoot: string,
  kind: "concepts" | "proofs",
  packageName: string,
  findings: FindingCollector,
): ModuleInventory {
  const packageDir = path.join(submissionRoot, kind);
  const paths = new Map<string, string>();
  const modules: string[] = [];
  const rootFile = path.join(packageDir, `${packageName}.lean`);
  if (!regularFile(rootFile)) findings.violate("layout", `${kind}/${packageName}.lean is missing`);
  paths.set(packageName, `${kind}/${packageName}.lean`);
  const moduleDir = path.join(packageDir, packageName);
  if (fs.existsSync(moduleDir)) {
    walk(moduleDir, [], (parts, isDirectory) => {
      if (isDirectory && kind === "concepts") {
        findings.violate("layout", `concept modules cannot be nested: ${kind}/${packageName}/${parts.join("/")}`);
        return false;
      }
      if (isDirectory) return true;
      const filename = parts.at(-1)!;
      if (!filename.endsWith(".lean")) return true;
      const components = [...parts.slice(0, -1), filename.slice(0, -5)];
      if (!components.every((component) => IDENTIFIER.test(component))) {
        findings.violate("layout", `${kind}/${packageName}/${parts.join("/")} is not a valid Lean module path`);
        return true;
      }
      const module = [packageName, ...components].join(".");
      modules.push(module);
      paths.set(module, `${kind}/${packageName}/${parts.join("/")}`);
      return true;
    });
  }
  modules.sort();
  return { packageName, packageDir, rootModule: packageName, modules, paths };
}

function walk(
  directory: string,
  relative: string[],
  visit: (parts: string[], isDirectory: boolean) => boolean,
): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const parts = [...relative, entry.name];
    if (entry.isDirectory()) {
      if (visit(parts, true)) walk(path.join(directory, entry.name), parts, visit);
    } else visit(parts, false);
  }
}

function regularFile(filename: string): boolean {
  try {
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}
