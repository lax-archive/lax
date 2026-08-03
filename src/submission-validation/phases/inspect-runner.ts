import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import type {
  ConclusionFacts,
  InspectorDeclaration,
  InspectorModule,
  InspectorReport,
  ModuleInventory,
  ParsedDoc,
  ResolutionResult,
} from "../contracts.js";
import type { ContainerRunner } from "../sandbox/container.js";

export async function runInspector(
  kind: "concepts" | "proofs",
  captureRoot: string,
  inventory: ModuleInventory,
  resolution: ResolutionResult,
  jobDir: string,
  dependencyRoot: string,
  runner: ContainerRunner,
  limits: ValidationLimits,
): Promise<InspectorReport> {
  const containerRoot = `/capture/${kind}/package`;
  const outputDir = path.join(jobDir, "checks", `inspect-${kind}`);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const plan = {
    tool: "inspect",
    cwd: containerRoot,
    // Inspect exactly the artifacts Replay authenticated, not the mutable
    // compilation library where authored elaboration could create shadows.
    ownLibs: kind === "proofs"
      ? ["/capture/proofs/lib", "/capture/concepts/lib"]
      : ["/capture/concepts/lib"],
    dependencyLibs: resolution.all.map(
      (dependency) => `/deps/${dependency.submissionId}/${dependency.kind}/lib`,
    ),
    args: ["/out/report.json", inventory.rootModule, ...inventory.modules],
  };
  fs.writeFileSync(path.join(outputDir, "plan.json"), `${JSON.stringify(plan)}\n`, { mode: 0o600 });
  const result = await runner.run({
    label: `inspect-${kind}`,
    args: ["node", "/opt/lax-runtime/bin/run-check.mjs", "/out/plan.json"],
    mounts: [
      { source: captureRoot, target: "/capture" },
      { source: outputDir, target: "/out", writable: true },
      ...(fs.existsSync(dependencyRoot) ? [{ source: dependencyRoot, target: "/deps" }] : []),
    ],
    env: { LEAN_NUM_THREADS: String(limits.leanThreads) },
    timeoutMs: limits.checkTimeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
  });
  if (result.code !== 0) {
    const reason = result.timedOut ? `${kind} inspection exceeded its time limit` : result.output.trim();
    throw new Error(reason || `${kind} inspection failed`);
  }
  const reportPath = path.join(outputDir, "report.json");
  const stat = fs.lstatSync(reportPath);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error(`${kind} inspector report is missing or oversized`);
  return parseInspectorReport(JSON.parse(fs.readFileSync(reportPath, "utf8")) as unknown);
}

function parseInspectorReport(value: unknown): InspectorReport {
  const report = record(value, "inspector report");
  exactKeys(report, ["modules", "declarations"], "inspector report");
  if (!Array.isArray(report.modules) || report.modules.length > 100_000)
    throw new Error("inspector modules must be a bounded array");
  if (!Array.isArray(report.declarations) || report.declarations.length > 1_000_000)
    throw new Error("inspector declarations must be a bounded array");
  return {
    modules: report.modules.map(parseModule),
    declarations: report.declarations.map(parseDeclaration),
  };
}

function parseModule(value: unknown, index: number): InspectorModule {
  const item = record(value, `inspector module ${index}`);
  exactKeys(item, ["name", "imports", "moduleDocs", "declCount"], `inspector module ${index}`);
  return {
    name: text(item.name, "module name"),
    imports: stringArray(item.imports, "module imports"),
    moduleDocs: array(item.moduleDocs, "module docs", 100).map(parseDoc),
    declCount: natural(item.declCount, "module declaration count"),
  };
}

function parseDeclaration(value: unknown, index: number): InspectorDeclaration {
  const item = record(value, `inspector declaration ${index}`);
  const allowed = [
    "name", "kind", "module", "axioms", "userName", "doc", "conclusionFacts",
    "signature", "startLine", "endLine",
  ];
  for (const key of Object.keys(item))
    if (!allowed.includes(key)) throw new Error(`inspector declaration ${index} has unknown key ${key}`);
  const declaration: InspectorDeclaration = {
    name: text(item.name, "declaration name"),
    kind: text(item.kind, "declaration kind"),
    module: text(item.module, "declaration module"),
    axioms: stringArray(item.axioms, "declaration axioms"),
  };
  if (item.userName !== undefined) declaration.userName = text(item.userName, "declaration userName");
  if (item.doc !== undefined) declaration.doc = parseDoc(item.doc, index);
  if (item.conclusionFacts !== undefined) declaration.conclusionFacts = parseConclusion(item.conclusionFacts);
  if (item.signature !== undefined) declaration.signature = text(item.signature, "declaration signature", 4 * 1024 * 1024);
  if (item.startLine !== undefined) declaration.startLine = natural(item.startLine, "declaration startLine");
  if (item.endLine !== undefined) declaration.endLine = natural(item.endLine, "declaration endLine");
  return declaration;
}

function parseDoc(value: unknown, index = 0): ParsedDoc {
  const item = record(value, `parsed doc ${index}`);
  const allowed = ["hasFrontmatter", "scalars", "lists", "description", "error"];
  for (const key of Object.keys(item)) if (!allowed.includes(key)) throw new Error(`parsed doc has unknown key ${key}`);
  if (typeof item.hasFrontmatter !== "boolean") throw new Error("parsed doc hasFrontmatter must be boolean");
  const scalars = array(item.scalars, "doc scalars", 100).map((pair): [string, string] => {
    const values = array(pair, "doc scalar pair", 2);
    if (values.length !== 2) throw new Error("doc scalar must be a pair");
    return [text(values[0], "doc scalar key"), text(values[1], "doc scalar value", 1024 * 1024)];
  });
  const lists = array(item.lists, "doc lists", 100).map((pair): [string, string[]] => {
    const values = array(pair, "doc list pair", 2);
    if (values.length !== 2) throw new Error("doc list must be a pair");
    return [text(values[0], "doc list key"), stringArray(values[1], "doc list values")];
  });
  return {
    hasFrontmatter: item.hasFrontmatter,
    scalars,
    lists,
    description: text(item.description, "doc description", 4 * 1024 * 1024),
    ...(item.error === undefined ? {} : { error: text(item.error, "doc error") }),
  };
}

function parseConclusion(value: unknown): ConclusionFacts {
  const item = record(value, "conclusion facts");
  const allowed = ["resolves", "isAxiom", "originModule", "originReachable", "defeq"];
  for (const key of Object.keys(item)) if (!allowed.includes(key)) throw new Error(`conclusion facts has unknown key ${key}`);
  for (const key of ["resolves", "isAxiom", "originReachable", "defeq"])
    if (typeof item[key] !== "boolean") throw new Error(`conclusion facts ${key} must be boolean`);
  return {
    resolves: item.resolves as boolean,
    isAxiom: item.isAxiom as boolean,
    originReachable: item.originReachable as boolean,
    defeq: item.defeq as boolean,
    ...(item.originModule === undefined ? {} : { originModule: text(item.originModule, "origin module") }),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has an invalid shape`);
}

function array(value: unknown, label: string, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must be a bounded array`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label, 100_000).map((entry) => text(entry, label));
}

function text(value: unknown, label: string, maxBytes = 16 * 1024): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes)
    throw new Error(`${label} must be a bounded string`);
  return value;
}

function natural(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}
