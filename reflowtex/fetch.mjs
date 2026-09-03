// Obtain the pinned ReflowTeX fork and prepare the encode environment (see
// README.md — node, no dependencies).
//
//   npm run reflowtex:fetch
//
// The pin lives in src/submission-validation/pins.ts — the single home of
// all pins — as REFLOWTEX_URL / REFLOWTEX_REV; this script parses that
// module so pins.ts stays authoritative. LAX_REFLOWTEX_SOURCE (read per
// call) substitutes a local git checkout for the clone source; the pinned
// rev must be present in it. Steps, each verified:
//
//   1. clone the source into checkout/ (gitignored) and detach at the rev;
//   2. install the hash-pinned Python env into venv/ (gitignored) from
//      requirements.lock; the venv is reused while the lock's hash matches
//      its stamp;
//   3. regenerate latex_pb2.py from the fork's schema into checkout/build/
//      with grpcio-tools' bundled protoc (never apt protoc, and never at
//      pipeline run time — the fork's _ensure_pb2 is verify-only);
//   4. import the generated module and assert both marker forms are present
//      (the proof that the checkout is the fork's branch, not stock upstream);
//   5. download the pinned PyMuPDF wheel into pymupdf/ (gitignored), verify
//      its sha256 *before* unpacking, and unpack it into pymupdf/lib/. That
//      one is not part of the encode environment at all: it is the picture
//      converter the trusted export step bind-mounts read-only into the
//      pinned TeX image (paper/web-container.ts), so it is a linux/amd64
//      wheel matching that image rather than this machine, and it is
//      deliberately kept out of venv/.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pinsFile = path.join(here, "..", "src", "submission-validation", "pins.ts");
const lockFile = path.join(here, "requirements.lock");
const checkoutDir = path.join(here, "checkout");
const venvDir = path.join(here, "venv");
const venvPython = path.join(venvDir, "bin", "python");
const pb2Dir = path.join(checkoutDir, "build");
const pymupdfDir = path.join(here, "pymupdf");
const pymupdfLibDir = path.join(pymupdfDir, "lib");

function pin(name, pattern) {
  const text = fs.readFileSync(pinsFile, "utf8");
  const match = new RegExp(`^export const ${name} = "([^"]+)";$`, "mu").exec(text);
  if (match === null || !pattern.test(match[1])) {
    throw new Error(`pins.ts does not pin ${name} (expected \`export const ${name} = "…";\`)`);
  }
  return match[1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

const url = pin("REFLOWTEX_URL", /^https:\/\/.+/u);
const rev = pin("REFLOWTEX_REV", /^[0-9a-f]{40}$/u);
const wheelName = pin("PYMUPDF_WHEEL", /^[A-Za-z0-9][A-Za-z0-9._+-]*\.whl$/u);
const wheelUrl = pin("PYMUPDF_URL", /^https:\/\/files\.pythonhosted\.org\/.+\.whl$/u);
const wheelSha256 = pin("PYMUPDF_SHA256", /^[0-9a-f]{64}$/u);
const source = process.env.LAX_REFLOWTEX_SOURCE ?? url;

// ── 0. one fetch at a time ────────────────────────────────────────────────
// Two callers (the e2e files' beforeAll hooks run in parallel forks) would
// otherwise race on checkout/: one removes the tree the other is checking
// out. A pid-stamped lock file serializes them; a lock left by a dead
// process is stale and reclaimed.
const fetchLock = path.join(here, ".fetch.lock");
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function acquireLock() {
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(fetchLock, `${process.pid}\n`, { flag: "wx" });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder = NaN;
      try {
        holder = Number.parseInt(fs.readFileSync(fetchLock, "utf8"), 10);
      } catch {
        // removed between the failed open and the read — retry
      }
      if (Number.isInteger(holder) && !alive(holder)) {
        fs.rmSync(fetchLock, { force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw new Error(`reflowtex fetch: could not acquire ${fetchLock} within 20 minutes`);
}
acquireLock();
process.on("exit", () => fs.rmSync(fetchLock, { force: true }));

// ── 1. checkout at the pinned rev ─────────────────────────────────────────
fs.rmSync(checkoutDir, { recursive: true, force: true });
if (fs.existsSync(source)) {
  run("git", ["clone", "--quiet", "--no-checkout", source, checkoutDir]);
} else {
  // The page-builder fetch pattern: blobless clone, then exactly the rev.
  run("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", source, checkoutDir]);
  run("git", ["-C", checkoutDir, "fetch", "--quiet", "--depth", "1", "origin", rev]);
}
run("git", ["-C", checkoutDir, "checkout", "--quiet", "--detach", rev]);
const resolved = execFileSync("git", ["-C", checkoutDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (resolved !== rev) throw new Error(`reflowtex resolved to ${resolved}, expected ${rev}`);

// ── 2. the hash-pinned Python env ─────────────────────────────────────────
const lockDigest = createHash("sha256").update(fs.readFileSync(lockFile)).digest("hex");
const stampFile = path.join(venvDir, ".requirements-lock-sha256");
const venvCurrent =
  fs.existsSync(venvPython) &&
  fs.existsSync(stampFile) &&
  fs.readFileSync(stampFile, "utf8").trim() === lockDigest;
if (!venvCurrent) {
  fs.rmSync(venvDir, { recursive: true, force: true });
  run("python3", ["-m", "venv", venvDir]);
  run(venvPython, [
    "-m", "pip", "install", "--disable-pip-version-check", "--quiet",
    "--require-hashes", "--requirement", lockFile,
  ]);
  fs.writeFileSync(stampFile, `${lockDigest}\n`);
}

// ── 3. latex_pb2.py, regenerated into the checkout's build area ───────────
fs.mkdirSync(pb2Dir, { recursive: true });
run(venvPython, [
  "-m", "grpc_tools.protoc",
  `--proto_path=${path.join(checkoutDir, "src", "schema")}`,
  `--python_out=${pb2Dir}`,
  "latex.proto",
]);

// ── 4. verify ─────────────────────────────────────────────────────────────
run(
  venvPython,
  [
    "-c",
    [
      "import latex_pb2 as L",
      "# NodeType spells it 'mark': proto2 scopes enum value names to the",
      "# package, and ItemKind claims 'marker' (see the fork's latex.proto).",
      "assert 'mark' in L.NodeType.keys(), 'NodeType.mark missing'",
      "assert 'marker' in L.ItemKind.keys(), 'ItemKind.marker missing'",
      "for m in (L.Node, L.ContentItem):",
      "    fields = m.DESCRIPTOR.fields_by_name",
      "    assert 'side' in fields and 'n' in fields, m.DESCRIPTOR.full_name + ' lacks side/n'",
      "print('latex_pb2: both marker forms present')",
    ].join("\n"),
  ],
  { env: { ...process.env, PYTHONPATH: pb2Dir } },
);
if (!fs.existsSync(path.join(pb2Dir, "latex_pb2.py"))) {
  throw new Error("latex_pb2.py was not generated");
}

// ── 5. the pinned PyMuPDF wheel, for the *container* ──────────────────────
// The same shape as the venv step: a stamp file records what is unpacked, so
// an unchanged pin is a no-op, and the sha256 is checked against the pin
// before a single byte is unpacked. LAX_PYMUPDF_WHEEL (read per call) points
// at a local copy of the same file — the hash still has to match, so it is a
// download shortcut and never a substitution.
const wheelStamp = path.join(pymupdfDir, ".wheel-sha256");
const pymupdfCurrent =
  fs.existsSync(path.join(pymupdfLibDir, "pymupdf", "__init__.py")) &&
  fs.existsSync(wheelStamp) &&
  fs.readFileSync(wheelStamp, "utf8").trim() === wheelSha256;
if (!pymupdfCurrent) {
  fs.rmSync(pymupdfDir, { recursive: true, force: true });
  fs.mkdirSync(pymupdfDir, { recursive: true });
  const wheelFile = path.join(pymupdfDir, wheelName);
  const local = process.env.LAX_PYMUPDF_WHEEL;
  if (local !== undefined && local !== "") {
    fs.copyFileSync(local, wheelFile);
  } else {
    const response = await fetch(wheelUrl, { redirect: "follow" });
    if (!response.ok) throw new Error(`downloading ${wheelUrl} failed with ${response.status}`);
    fs.writeFileSync(wheelFile, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash("sha256").update(fs.readFileSync(wheelFile)).digest("hex");
  if (digest !== wheelSha256) {
    fs.rmSync(pymupdfDir, { recursive: true, force: true });
    throw new Error(`${wheelName} hashes to ${digest}, expected ${wheelSha256}`);
  }
  // A wheel is a zip; python3 unpacks it without adding a dependency (and
  // without running any of its code — `pip install` would run hooks and would
  // also resolve for *this* platform, which is not the one it is for).
  fs.mkdirSync(pymupdfLibDir, { recursive: true });
  run("python3", [
    "-c",
    "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
    wheelFile,
    pymupdfLibDir,
  ]);
  if (!fs.existsSync(path.join(pymupdfLibDir, "pymupdf", "__init__.py"))) {
    throw new Error(`${wheelName} does not carry a pymupdf package`);
  }
  fs.rmSync(wheelFile, { force: true });
  fs.writeFileSync(wheelStamp, `${wheelSha256}\n`);
}

console.log(`Fetched reflowtex at ${rev} (${source === url ? url : source}), ` +
  `env ${venvCurrent ? "reused" : "installed"}, latex_pb2.py regenerated, ` +
  `pymupdf ${pymupdfCurrent ? "reused" : "unpacked"}.`);
