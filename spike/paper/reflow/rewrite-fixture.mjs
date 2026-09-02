// Run the REAL lax rewriter (dist/submission-validation/paper/rewrite.js —
// build the repo first) over a fixture directory: every marker comment
// becomes \laxmark{b|e}{n}, numbering per texRewriteOrder, and the mark
// table lands beside the rewritten copies as marks.json.
//
//   node rewrite-fixture.mjs <srcdir> <outdir> --main body.tex [--only a.tex,b.tex]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { rewriteMarkers, texRewriteOrder } = await import(
  new URL("../../../dist/submission-validation/paper/rewrite.js", import.meta.url).href
);

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [srcdir, outdir] = positional;
const main = flag("main") ?? "body.tex";
const only = flag("only")?.split(",");

const all = readdirSync(srcdir).filter((f) => f.endsWith(".tex"));
const order = texRewriteOrder(main, only ?? all);
const files = order.map((path) => ({ path, text: readFileSync(join(srcdir, path), "utf8") }));
const { rewritten, marks, problems } = rewriteMarkers(files);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
mkdirSync(outdir, { recursive: true });
for (const f of rewritten) writeFileSync(join(outdir, f.path), f.text);
writeFileSync(join(outdir, "marks.json"), JSON.stringify(marks, null, 2) + "\n");
console.log(
  `${marks.length} mark(s): ` +
    marks.map((m) => `${m.n}=${m.id}@${m.file}:${m.line}`).join(" "),
);
