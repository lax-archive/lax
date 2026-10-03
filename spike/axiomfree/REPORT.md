# Spike: `lake comparator` / `lake check` for an axiom-free proof network

Stage 0 of the axiom-free design change, run 2026-10-03 on Jan's box (Fable
agent, unreviewed): Ubuntu 24.04, kernel 6.8.0-142, 4 cores, 18 GB RAM +
19 GB swap, docker 28.1.1, bubblewrap 0.9.0, elan 4.2.3. Question: can Lax
certify spec-2 proof networks (claims as `def X : Prop := T`, proofs as
`theorem Q (hA : A) : C` over such statement constants) kernel-only with the
comparator that ships inside the Lean toolchain since v4.35.0-rc2, and what
does a run cost? Every number below was measured; the raw logs are in
`logs/` (one file per step, `/usr/bin/time -v` beside it), the project is
`project/`, the drivers are `scripts/` and `docker/`.

## Verdict

**GO for the shape, with two blockers Lax owns and one memory wall.**
`lake comparator` does exactly the spec-2 check: the named certificate
theorems must have *structurally identical* statements in the challenge
(imports concepts only) and the solution (imports the proof package); every
constant reachable from those statements is compared whole, definition
bodies included; the solution's axiom closure is held to the permitted list;
the Lean kernel (and, with `--paranoid`, five more) replays the solution's
export. The three negative tests that matter all fail as they must: a
defeq-but-unfolded conclusion is rejected (`Challenge and solution theorem
statement do not match: 'Cert.pf'`), so the spec must demand the statement
constant itself, not anything definitionally equal to it; `sorry` is
rejected (`Illegal axiom detected: 'sorryAx'`); a module shadowing a concept
under the same name is rejected either by Lean (duplicate import) or by the
comparator (`Const does not match between challenge and target
'Concepts.InfinitelyManyPrimes'`). Spec-1 style (axiom claims, `type_of%`
certificates, a permitted archive axiom) works too, including relative
certificates. A per-submit comparator run on a two-theorem network over
mathlib takes about 10 s warm, 31 s with `--paranoid`; the sandbox costs
nothing measurable.

What blocks: (1) **the sandbox**. The comparator refuses to run without
`bwrap` and user namespaces. On this box it works only because of a local,
package-less AppArmor profile (`/etc/apparmor.d/usr.bin.bwrap-userns`); plain
`unshare -Ur` is denied. Inside Lax's pinned container family the probe needs
`--security-opt seccomp=unconfined` *and* `--security-opt apparmor=unconfined`
(neither alone, and `--cap-add SYS_ADMIN` does not substitute), and the real
`lake comparator` additionally needs `--security-opt systempaths=unconfined`,
a world-writable tmpfs on `/run`, and `git` in the image — i.e. a Dockerfile,
against the stock-image rule — before it passes (21 s). What a GitHub-hosted
runner allows was not measured. The alternative that needs none of this is
Palomar's: run it on the VM. (2) **Spec 2 must say `@[expose] public def`
(or `public abbrev`) for statements and `public theorem` for the named
proofs**: a plain `public def` is visible but not unfoldable from a `module`
importer, so `h : ExistsPrimeDivisor` cannot even be applied, and a
non-`public` theorem is an unknown identifier to the solution. The memory
wall: `lake check` (challenge-less) exports the *whole closure* of the
default targets — 162,304 declarations / 714 MB for this two-theorem project
— and `nanoda` on that export passed 17 GB RSS and was killed; `leanchecker`
replays it in 3.2 min at 1.1 GB. Per-cone costs scale at roughly 1–2 ms per
declaration for export and for `leanchecker` each, ~5–9 ms per declaration
for the full paranoid set.

## Measurements

All commands run from `project/` with `PATH=$HOME/.elan/bin:$PATH` unless
noted; wall = `/usr/bin/time -v` elapsed; RSS = its max resident set size
(for sandboxed runs it does **not** include the bwrap'd descendants — see
Findings). "decls" counts the `thm`+`def`+`inductive`+`opaque` records of
the export.

| item | command | result |
|---|---|---|
| toolchain install | `elan toolchain install leanprover/lean4:v4.35.0-rc3` | 53.10 s wall, 3.0 GB (`du -sh`); 18 GB → 15 GB free; `Lean (version 4.35.0-rc3, commit 470d5ce…)`, `Lake version 5.0.0-src+470d5ce` |
| bundled checkers | `ls …/bin` | all present: leanexport 644,688 B, leanchecker 59,832 B, leanchecker-paranoid 8,816,864 B, lean4lean 36,897,680 B, nanoda_bin 1,299,760 B, con-leche 18,506,216 B, con-ron 3,649,920 B |
| `lake --help` | | line 19 `comparator  judge a solution against a challenge`, line 20 `check  check this project against external checker(s)`; `lake comparator --help` / `lake check --help` both exit 0 (full text `logs/lake-help.log`) |
| bwrap on host | `bwrap --ro-bind / / --tmpfs /tmp --unshare-all --die-with-parent -- /bin/true` | exit 0, no output; inside: uid 1000, `uid_map` = `1000 1000 1`, label `/usr/bin/bwrap (unconfined)` |
| userns without the bwrap profile, host | `unshare -Ur /bin/true` | `unshare: write failed /proc/self/uid_map: Operation not permitted`, exit 1 |
| bwrap in docker, defaults / `--user 1000:1000` / lax flags (`--read-only --cap-drop=ALL --security-opt=no-new-privileges --user 1000:1000 --tmpfs /tmp`) | `docker run --rm … lax-spike-bwrap:v1 sh -c '<probe>'` | `bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.` exit 1 (all three) |
| + `seccomp=unconfined` only | | `bwrap: Failed to make / slave: Permission denied` exit 1 |
| + `apparmor=unconfined` only | | `No permissions to create new namespace` exit 1 |
| + both unconfined (also with `--user 1000:1000`, also with lax flags) | | exit 0 |
| + `--cap-add SYS_ADMIN` alone / + seccomp / + apparmor | | `Failed to make / slave` / `Failed to make / slave` / `bwrap: pivot_root: Operation not permitted`, exit 1 each |
| + SYS_ADMIN + both unconfined; `--privileged` | | exit 0; exit 0 |
| real `lake comparator` in docker, lax flags + both unconfined | `docker/comparator-in-docker.sh` | `bwrap: Can't mkdir /run/user: Read-only file system` → exit 1; with `--tmpfs /run` (root 755): `mkdir: cannot create directory '/run/user': Permission denied`; with 1777 tmpfs on `/run`: `bwrap: Can't mount proc on /newroot/proc: Operation not permitted`; **+ `--security-opt systempaths=unconfined`: `Your solution is okay!` exit 0, 21.36 s**; `--privileged` variant: exit 0, 9.42 s |
| `lake update` (mathlib `v4.35.0-rc3` = `c55e6e786f49471c72fbddbec5415808896aec1e`) | `lake update` | 4:00.95 wall, 984 MB RSS; **includes mathlib's post-update hook running `cache get`** (42 jobs to build `Cache`, 8943 files downloaded + decompressed); 9 packages; disk 15 GB → 7.4 GB |
| explicit cache get afterwards | `lake exe cache get` | 8.26 s, `No files to download`, `Already decompressed 8943 file(s)` |
| disk footprint | `du -sh` | `project/.lake` 7.2 GB (mathlib 6.8 GB), `~/.cache/mathlib` 2.5 GB (50,472 `.ltar`), toolchain 3.0 GB |
| build default targets (Concepts, Proofs) | `lake build` | 3.60 s, 629 jobs (627 from cache), 854 MB RSS |
| comparator, cold (Solution built in the sandbox) | `lake comparator --config comparator.json` | exit 0, 11.44 s; resolve ≈1.0 s, build Challenge ≈1.2 s, export ≈1.9 s, build Solution ≈2.2 s, export ≈3.4 s, leanchecker ≈1.7 s |
| comparator, warm | same | exit 0, 9.98 s |
| comparator, `--inadvisably-no-sandbox` | | exit 0, 10.53 s (`WARNING: Sandbox disabled, this run is not trustworthy.`), 1.59 GB RSS |
| comparator `--paranoid` | `lake comparator --config comparator.json --paranoid` | exit 0, 30.72 s: Lean paranoid 2.1 s, lean4lean 2.1 s (`checked 3000 declarations`), nanoda 0.4 s, con-leche 7.1 s (`accepted 2999 declarations`), con-ron 9.7 s (2999), Lean default 1.75 s |
| `lake check` (sandboxed, default targets) | `lake check` | exit 0, **284.56 s**: build+export ≈57 s, `leanchecker` ≈227 s; `Uses axioms: propext, Quot.sound, Classical.choice` |
| the export `lake check` replayed (reproduced) | `LAKE_CHECK_EXPORT=1 lake check > check-all.export` | 714,281,819 B, 12,687,421 lines, 162,304 decls (thm 83,507 / def 74,069 / inductive 2,635 / opaque 2,093; 4 axioms); 64.38 s, 3.03 GB RSS |
| leanchecker on it | `leanchecker --silent --from-export check-all.export` | exit 0, 192.64 s, 1.13 GB RSS |
| nanoda on it | `nanoda_bin <cfg>` (4 threads) | **killed by the agent after 388 s** at VmHWM 17.07 GB (+7.6 GB swap, box thrashing: PSI full avg60 37 %), exit 137 |
| `lake check --from-export` on cone 3 | `lake check --from-export cone3-pi-gt-three.export` | exit 0, 16.85 s (leanchecker only + axiom report) |
| neg (a) unfolded conclusion | `lake comparator --config comparator-defeq.json` | exit 1, 8.54 s: `error: Challenge and solution theorem statement do not match: 'Cert.pf'` |
| neg (b) `sorry` | `… comparator-sorry.json` | exit 1, 8.53 s: `error: Illegal axiom detected: 'sorryAx'` |
| neg (c) shadowing module, defs not exposed | `… comparator-shadow.json` | exit 1, 8.34 s: Lean refuses the solution (`Type mismatch … has type True but is expected to have type Concepts.ExistsPrimeDivisor`), `error: Child exited with 1` |
| neg (c) shadowing module, `@[expose]` defs | same | exit 1, 10.37 s: `error: Const does not match between challenge and target 'Concepts.InfinitelyManyPrimes'` |
| neg (c') importing real + shadow | `… comparator-shadowboth.json` | exit 1, 7.91 s: `error: SolutionShadowBoth.lean:1:0: import ConceptsShadow failed, environment already contains 'Concepts.InfinitelyManyPrimes' from Concepts` |
| spec-1 certificate (`type_of%`) | `lake comparator --config comparator1.json` | exit 0, 12.79 s (`type_of% Concepts1.AxStmt` elaborates) |
| spec-1, axiom used but not permitted | `… comparator1-ax-not-permitted.json` | exit 1, 9.36 s: `error: Illegal axiom detected: 'Concepts1.AxStmt'` |
| spec-1, relative certificate (axiom permitted) | `… comparator1-relative.json` | exit 0, 8.35 s (kernel 0.23 s) |
| exit code 2 | missing config / missing `--solution-from-export` file / `COMPARATOR_BWRAP=/nonexistent` / no `lake-manifest.json` | exit 2 each (`logs/exit-code-2-probes.log`) |
| module: non-public def / theorem | `lake build ModTest.UseModule` | `Unknown identifier `ModTest.hiddenDef``, `Unknown identifier `ModTest.hiddenThm`` (same from the non-`module` importer `ModTest.UseLegacy`) |
| module: `public def`, not `@[expose]` | same | `module` importer: `Type mismatch … Note: The following definitions were not unfolded because their definition is not exposed: ModTest.notExposed ↦ 1`; non-`module` importer: **compiles** |
| module: `public abbrev`, `@[expose] public def` | same | both unfold fine from both importers |
| module: file without `module` header | `lake build NoHeader` | exit 0 (`import Mathlib.Data.Nat.Prime.Defs` the legacy way builds; header not mandatory) |
| cone 1 `Nat.exists_infinite_primes` (`Mathlib.Data.Nat.Prime.Infinite`) | `lake env leanexport <Module> -- <decl>` | 11,674,093 B, 224,145 lines, 2,998 decls; export 4.09 s / 1.58 GB |
| cone 1 kernels | `leanchecker --silent --from-export` / `leanchecker-paranoid --silent --from-export` / `lean4lean --import` / `nanoda_bin cfg.json` / `con-leche x` / `con-ron x` | 2.21 s/129 MB · 2.49 s/44.5 MB · 2.20 s/54 MB (2995) · 0.43 s/23.7 MB · 3.64 s/57.6 MB (2994) · 5.11 s/122 MB (2994); all exit 0 |
| cone 2 `Nat.exists_prime_lt_and_le_two_mul` (`Mathlib.NumberTheory.Bertrand`) | | 184,765,445 B, 3,429,526 lines, 30,165 decls; export 28.74 s / 2.77 GB |
| cone 2 kernels | same order | 66.16 s/447 MB · 59.65 s/414 MB · 64.62 s/372 MB (30162) · 15.68 s/295 MB · 35.53 s/279 MB (30161) · 37.75 s/614 MB (30161); all exit 0 |
| cone 3 `Real.pi_gt_three` (`Mathlib.Analysis.Real.Pi.Bounds`) | | 69,649,001 B, 1,307,747 lines, 15,660 decls; export 12.16 s / 2.67 GB |
| cone 3 kernels | same order | 15.73 s/217 MB · 16.93 s/152 MB · 15.41 s/142 MB (15657) · 3.15 s/98 MB · 10.77 s/149 MB (15656) · 13.11 s/290 MB (15656); all exit 0 |

Per-declaration rates from the table (single runs, 4 cores, one kernel at a
time): export 0.4–1.4 ms/decl (cone 1 is dominated by the ~3 s startup);
`leanchecker` 1.0–2.2 ms/decl; `lean4lean` and `leanchecker-paranoid` the
same as `leanchecker`; `nanoda` 0.2–0.5 ms/decl (4 threads) but the memory
hog; `con-leche`/`con-ron` 0.7–1.3 ms/decl. The full `--paranoid` set is
4.8 ms/decl at 15.7k decls and 9.3 ms/decl at 30k.

**Extrapolation (a guess, not a measurement).** Lax17, the largest
submission, has 405 modules and 38,484 declarations of its own; the size of
its mathlib cone was not measured. If a certificate's cone were ten times
the whole-closure export here (1.6 M declarations, ~7 GB of NDJSON), the
rates above put export at ~10–25 min and `leanchecker` at ~30–60 min — inside
a 6-hour job for a single `leanchecker` pass, but the export process already
needed 3 GB at 162k declarations and `nanoda` needed more than 17 GB, so
`--paranoid` at that scale is unlikely to fit the memory of any runner this
spike can speak for. A per-submit comparator run exports only the cones of
the named theorems (3k declarations, 10 s here), so its cost is set by the
statements' cones, not by the proof package's size. A whole-archive run is
one such cone per certificate theorem, or one whole-closure export per
package; neither total was measured.

## Findings

### The toolchain (task 1)

- Everything the plan relies on is in the release tarball: `lake
  comparator`, `lake check`, and the seven binaries. `lake check` and
  `lake comparator` document exit codes 0 (accepted), 1 (rejected: statement
  mismatch, forbidden axiom, kernel rejection, build failure), 2 (could not
  start); all three were observed (table).
- A Lean compile error in the solution is also exit 1, reported as
  `error: Child exited with 1` after the build log — the comparator does not
  distinguish "does not compile" from "wrong".
- The exporter is always the toolchain's own `leanexport` (the help text
  says so; `--*-from-export` files are not checked against the project).

### bubblewrap (task 2)

- Host success rests on `/etc/apparmor.d/usr.bin.bwrap-userns` (96 bytes,
  dated 2026-03-15, `dpkg -S` finds no owner; neither `bubblewrap
  0.9.0-1ubuntu0.3` nor `apparmor 4.0.1really4.0.1-0ubuntu0.24.04.7` ships
  it): `/usr/bin/bwrap flags=(default_allow) { userns, }`. With
  `kernel.apparmor_restrict_unprivileged_userns=1`, an unconfined process
  cannot create a usable user namespace (`unshare -Ur` fails writing
  `uid_map`); the profile is what lets bwrap do it. A stock Ubuntu 24.04 host
  without that profile was not tested.
- In docker the two blocks are separate: the default seccomp profile blocks
  `unshare(CLONE_NEWUSER)` (`apparmor=unconfined` alone still fails
  `unshare -Ur`; `seccomp=unconfined` alone makes `unshare -Ur` succeed), and
  the `docker-default` AppArmor profile blocks the mount operations
  (`Failed to make / slave`). With `apparmor=unconfined` the container's
  bwrap is labelled `/usr/bin/bwrap (unconfined)` — the host's path-based
  profile attaches to the container's `/usr/bin/bwrap` too, which is why
  the pair works here and may not elsewhere.
- Lax's current run flags (`--read-only --cap-drop=ALL
  --security-opt=no-new-privileges --user uid:gid`, no `--privileged`) are
  compatible with the probe once both profiles are lifted; the real
  comparator further needs `systempaths=unconfined` (its `--proc /proc`
  remount fails under docker's masked `/proc` paths), `/run/user` creatable
  (the slim image has no `/run/user`, and bwrap must `mkdir` it inside its
  read-only bind of `/`), and `git` (refuses to start without it:
  `needs `git` on PATH to build inside the sandbox`). Those are
  `docker/Dockerfile.git` and `docker/comparator-in-docker.sh`, reported
  here, not recommended.
- The sandbox is cheap: 10.53 s without, 9.98–11.44 s with.

### The comparator's semantics, from source and from the tests (task 3)

- `Lake/Check/Compare.lean`: for each `theorem_names` entry both exports
  must hold a `thm` (or both an `axiom`) whose `ConstantVal` — name,
  universe params, type `Expr` — is `==`; then every constant used by that
  type is compared as a whole `ConstantInfo` transitively (bodies included),
  and every `permitted_axioms` entry is compared the same way. Consequences
  measured: (a) the unfolded conclusion fails even though it is defeq, so
  spec 2 may **not** allow definitional unfolding in certificates; (c) a
  same-named shadow definition fails on its body; and a permitted archive
  axiom must exist with the identical statement in both exports (which is
  why `Challenge1` imports `Concepts1`).
- `Lake/Check/Axioms.lean` walks the solution's proof closure of the named
  theorems and rejects any axiom outside the list (`Illegal axiom detected`)
  — this, not the kernel, is what catches `sorry`. The challenge's own
  `sorry` is never checked. Named theorems must be `theorem` in the solution
  (`Solution constant is not a theorem` in the source; not exercised).
- `lake check` exports **the entire closure of the default targets** (every
  mathlib declaration reachable from the imports: 162,304 for this project)
  and replays all of it; `lake comparator` exports only the cones of the
  named theorems plus a fixed primitive list (`Nat.add`, …, `Quot`, …) —
  ~3,000 here. For an archive check that is the difference between 10 s and
  5 min per package, and between 1 GB and >17 GB for `nanoda`.
- Export format: NDJSON, `lean4export` format 3.1.0 (`{"meta":…}` first
  line), hash-consed names (`in`), levels (`il`), exprs (`ie`), then
  declaration records (`thm`, `def`, `inductive`, `axiom`, `opaque`,
  `quot`). Mathlib-shaped exports are 95 % expression records.
- Output format: phases print to stdout (`Resolving dependencies`,
  `Building X`, `Exporting #[…] from X`, `Running <kernel> kernel on
  solution`, `<kernel> kernel accepts/rejected the solution`, `Your solution
  is okay!` / `Uses axioms: …`), errors to stderr as `error: …`. Lean's
  stdout is buffered and flushes at each child spawn, so a line-timestamped
  log shows the error *before* the `Exporting … from Solution` line and
  phase boundaries only where a child starts; the per-phase numbers in the
  table are read off those child boundaries.
- `/usr/bin/time -v` on a sandboxed run reports the max RSS of the
  direct child tree it can see: 1.14 GB for `lake check` while the inner
  export process was observed at 2.9 GB (`ps`), and 1.59 GB for the
  no-sandbox comparator vs 0.14 GB sandboxed. Memory of sandboxed phases
  must be measured inside.
- `lake update` on mathlib `v4.35.0-rc3` runs `cache get` itself (post-update
  hook), after compiling the `Cache` executable; the 4:00.95 includes the
  2.5 GB download. One environment costs 12.7 GB on disk.
- The `Replayed Challenge` lines are Lake replaying a cached build log; the
  comparator rebuilds nothing that is up to date, so the warm path is
  resolve + two exports + kernel.

### Spec-1 style (task 4)

`type_of% Concepts1.AxStmt` elaborates under v4.35.0-rc3 as a theorem type
in a `module` file. The comparator accepts the proof-from-mathlib
certificate, rejects the certificate that uses the archive axiom when it is
not in `permitted_axioms`, and accepts it when it is. So the relative
certificate shape of spec 1 is expressible with this tool unchanged.

### The module system (task 5)

| declaration in `module` file `Hidden` | from a `module` importer | from a non-`module` importer |
|---|---|---|
| `def` / `theorem` (not public) | unknown identifier | unknown identifier |
| `public def` (not `@[expose]`) | visible, **not unfoldable** | visible and unfoldable |
| `public abbrev` | unfoldable | unfoldable |
| `@[expose] public def` | unfoldable | unfoldable |
| `public theorem` | referenceable | referenceable |

What spec 2 must require: statement constants as `@[expose] public def`
(or `public abbrev`), named proofs as `public theorem`; helper lemmas may
stay non-public (the solution compiled with private helpers behind a public
`pf`). `module` headers are not mandatory in v4.35 (`NoHeader.lean` builds),
and a non-`module` proof package sees more than a `module` one does, so the
spec should say which header proof packages carry. Also learned the hard
way: in a `module` file the imports must directly follow `module`; a `/-!
-/` block between them is a parse error (`unexpected token 'import'`).

### Side observations

- Free disk rose from 7.3 GB to 15 GB and later 38 GB during the run
  without this spike deleting anything (all spike data intact afterwards);
  something else on the box freed it. The 5 GB gate was never crossed (low
  point 6.9 GB during the `lake check` export).
- `git status` showed `M TODO.md` and `?? axiomfree-plan.md` at the end;
  neither is this spike's doing (another session edits the tree).
- Cone 2's `leanchecker` run overlapped for a few seconds with a `docker
  build` (apt-get of git); its 66 s may be slightly high relative to the
  other three kernels at ~60–65 s.
- `push_neg` is deprecated at this mathlib (`Prefer using push Not`).

## What this did not prove

Nothing here ran on a GitHub-hosted runner: whether its kernel/AppArmor
lets bwrap create user namespaces, with or without a container, is the open
question that decides VM-vs-container, and the host result here depends on
a profile no package ships. Memory was measured for one two-theorem project
over the `Nat.Prime`/`Factorial` cone and three mathlib cones up to 30k
declarations; no Lax-sized cone (Lax17: 405 modules, 38,484 declarations)
was exported, and only `leanchecker` and `nanoda` were run on the 162k
whole-closure export (`lean4lean`, `con-leche`, `con-ron`,
`leanchecker-paranoid` were not). All timings are single runs. v4.35.0-rc3
was measured, not a final v4.35.0, and mathlib at its `v4.35.0-rc3` tag.
`definition_names` holes, external kernels, `lake check` with a `sorry`
module among the default targets, and the comparator's behaviour on a
project whose manifest pins a different toolchain were not exercised. The
docker variants that pass are reported, not vetted: lifting seccomp,
AppArmor and masked paths changes what the container sandbox guarantees,
and that trade was not analysed.

## Stage 0 confirmations (2026-10-03, evening)

The "remaining half-day" of stage 0 in `axiomfree-plan.md`: decision 7
(header-less files) end to end through the comparator, and decision 4 (the
`@[lax_statement]` tag attribute read as data by a core-only inspector with
initializers disabled). Same box, same toolchain and mathlib as above; every
command run from `project/` with `PATH=$HOME/.elan/bin:$PATH` through
`scripts/run-timed.sh`, logs in `logs/<tag>.log` + `.time`. New material:
`project/*Plain*.lean`, `project/*Tagged*.lean`, `project/NegTagged*.lean`,
`project/comparator-plain*.json`, `project/comparator-tagged.json`, the
scratch package `laxcore/` (one module, `import Lean` only), the core-only
reader `tagreader/` (`Main.lean`, never imports `LaxCore`), the driver
`scripts/tagreader.sh`, and `lakefile-stage0-libs.toml` (what was appended
to `project/lakefile.toml`, including the `LaxCore` path require).

### 1. Header-less Challenge/Solution — **GO**

Files: `ConceptsPlain.lean` (`import Mathlib.Data.Nat.Prime.Defs`, two
`def X : Prop := …`, nothing else), `ProofsPlain.lean` (hypothesis-style
`theorem pf (h : ConceptsPlain.ExistsPrimeDivisor) :
ConceptsPlain.InfinitelyManyPrimes`), `ChallengePlain.lean` (imports
`ConceptsPlain` only, `theorem CertPlain.pf (h : …) : … := sorry`),
`SolutionPlain.lean` (imports `ProofsPlain`, bodies `ProofsPlain.pf h`),
`SolutionPlainDefeq.lean` (the unfolded-conclusion negative), and
`ChallengePlainOfModule.lean`/`SolutionPlainOfModule.lean` (header-less
certificate over the *`module`-style* `Concepts`/`Proofs` pair). No
`module`, no `public`, no `@[expose]`, no attributes anywhere.

| tag | command | result |
|---|---|---|
| `plain-build` | `lake build ConceptsPlain ProofsPlain ChallengePlain SolutionPlain SolutionPlainDefeq ChallengePlainOfModule SolutionPlainOfModule` | exit 0, 5.54 s, 641 jobs |
| `plain-comparator-cold` | `lake comparator --config comparator-plain.json` | **exit 0, 8.54 s**, `Your solution is okay!` (build Challenge ≈1.2 s, export ≈1.2 s, build Solution ≈1.2 s, export ≈2.4 s, kernel ≈1.5 s) |
| `plain-comparator-warm` | same | exit 0, 8.39 s |
| `plain-neg-defeq` | `lake comparator --config comparator-plain-defeq.json` | **exit 1, 6.76 s**, `error: Challenge and solution theorem statement do not match: 'CertPlain.pf'` |
| `plain-of-module-comparator` | `lake comparator --config comparator-plain-of-module.json` | exit 0, 8.30 s — a header-less Challenge/Solution over `module`-style concept and proof files is accepted |

Nothing surprising: the plain `def X : Prop` is unfoldable from the
header-less proof package (the `h (n.factorial + 1) …` application
elaborates), the comparator's statement comparison and cone export behave
exactly as with the `module` pair, and the run is ~1.5 s faster than the
`module` pair measured earlier (8.4 s vs 10.0 s warm) — within single-run
noise, not a claim. Decision 7 is confirmed end to end; the "`@[expose]
public def` or `public abbrev`" blocker in the Verdict above applies only
to `module` files and is moot under decision 7.

### 2. The attribute read as data — **GO**, with one plan sentence to amend

`laxcore/LaxCore.lean` (built in 6.08 s, `laxcore-build`):

```lean
initialize laxStatementAttr : TagAttribute ←
  registerTagAttribute `lax_statement "…" (validate := validateStatement)
```

inside `namespace LaxCore`, where `validateStatement : Name → AttrM Unit`
rejects, in this order, `isPrivateName decl`, a non-`defnInfo`, and a
stored type (`consumeMData`) that is not literally `.sort .zero` — a
`.forallE` gets the "has binders" message, anything else "has type `T`". A
second, spike-only tag `lax_statement_unchecked` (no hook) exists to see
what the exporter does with a `private` tagged def, since the hook never
lets one through.

Positives (`tagged-build`, 6.13 s): `ConceptsTagged.lean` (header-less,
`import LaxCore`, two tagged statements + untagged `def Auxiliary : Prop`),
`ConceptsTaggedPrivate.lean` (tagged `Visible`, unchecked-tagged
`VisibleUnchecked` and `private Hidden`), `ProofsTagged`/`ChallengeTagged`/
`SolutionTagged`. Negatives, each a one-line file, each `lake build <lib>`
exit 1 in 2.2–2.7 s (`neg-tagged-*`):

| file | message |
|---|---|
| `@[lax_statement] theorem t : True` | `@[lax_statement]: `NegTaggedTheorem.t` is a theorem; a statement must be a `def` of type `Prop`` |
| `@[lax_statement] def P (n : Nat) : Prop` | `… `NegTaggedBinder.P` has binders; a statement takes no parameters (quantify inside with `∀`)` |
| `@[lax_statement] def T : Type` | `… `NegTaggedType.T` has type `Type`; a statement must have type `Prop`` |
| `@[lax_statement] private def H : Prop` | `… `_private.NegTaggedPrivate.0.NegTaggedPrivate.H` is private; a statement must be visible to the packages that depend on it` |
| `attribute [lax_statement] ConceptsTagged.Auxiliary` in another module | Lean's own: `Cannot add attribute `[lax_statement]` to declaration `ConceptsTagged.Auxiliary` because it is in an imported module` |

**The reading.** `tagreader/Main.lean` imports `Lean` only, and loads with
the inspector's exact call:

```lean
initSearchPath (← findSysroot)
let env ← importModules imports {} (trustLevel := 1024) (loadExts := false)
for i in [0:env.header.moduleNames.size] do
  for (extName, es) in env.header.moduleData[i]!.entries do
    if (privateToUserName? extName).getD extName == `LaxCore.laxStatementAttr then
      for e in es do
        let decl := (unsafeCast e : Name)   -- the entry type of a TagAttribute is Name
        …
```

run as `scripts/tagreader.sh LaxCore.laxStatementAttr ConceptsTagged
ConceptsTaggedPrivate` (the script only sets `LEAN_PATH` from `lake env
printenv LEAN_PATH`; no lake process is involved in the read):

| tag | result |
|---|---|
| `tagreader-concepts` | exit 0, 2.06 s, 1.56 GB RSS, 2897 modules loaded (the mathlib closure); `ConceptsTagged` carries the extension **`LaxCore.laxStatementAttr` (2 entries)**; listed: `ConceptsTagged.InfinitelyManyPrimes`, `ConceptsTagged.ExistsPrimeDivisor`, `ConceptsTaggedPrivate.Visible`, each `kind=def isProp=true private=false levelParams=[]`; `Auxiliary` absent; **3 tagged declaration(s)** |
| `tagreader-unchecked` | same for `LaxCore.laxStatementUncheckedAttr`: `ConceptsTaggedPrivate.VisibleUnchecked` **and** `_private.ConceptsTaggedPrivate.0.ConceptsTaggedPrivate.Hidden [… private=true]` — the private def **is** in the entries |

Facts the next stages must know:

- **Extension name = the `initialize` declaration's name**, not the
  attribute's: `registerTagAttribute` passes `ref := by exact decl_name%`
  as the persistent extension's `name`, so the entries sit under
  `LaxCore.laxStatementAttr` (the attribute `lax_statement` names nothing
  in the olean). Renaming or namespacing the initializer in the real
  `lax-core` changes the key; a `private initialize` would mangle it to
  `_private.LaxCore.0.LaxCore.laxStatementAttr`, which the inspector's
  `(privateToUserName? extName).getD extName` comparison already absorbs.
  The real `lax-core` should fix the initializer name as part of its
  interface and the inspector should pin it as a constant.
- **Entry type is `Name`**: `TagAttribute.ext : PersistentEnvExtension Name
  Name NameSet`, `exportEntriesFnEx` writes an `Array Name` sorted by
  `Name.quickLt` per module. The inspector cannot name
  `LaxCore.laxStatementAttr` for a shape guard (it does not import
  LaxCore); the guard goes on `Lean.TagAttribute`, whose `mk` is
  `(attr : Lean.AttributeImpl) -> (ext : Lean.PersistentEnvExtension
  Lean.Name Lean.Name Lean.NameSet) -> Lean.TagAttribute` under this
  toolchain — that is what fixes the entry type.
- **Loading flags**: `importModules imports {} (trustLevel := 1024)
  (loadExts := false)` after `initSearchPath (← findSysroot)` with
  `LEAN_PATH` covering the package, its dependencies and LaxCore — the
  inspector's current call, unchanged. `level` stays at its default
  `.private`: a header-less module has one `.olean` and it is written at
  that level. LaxCore's olean is loaded as data (it is in the import
  closure) and its `initialize` never runs; the attribute is not
  registered in the reader process and nothing needs it to be.
- **Private declarations: the olean filter is a module-system feature.**
  `writeModule` emits one `.olean` for a non-`module` file via
  `mkModuleData env` at level `.private`, and `registerTagAttribute`'s
  `exportEntriesFnEx` returns `{ exported := filtered, server := filtered,
  private := all }` — so for the header-less files decision 7 prescribes,
  a `private` tagged def **does** reach the entries (measured above). The
  plan's decision-4 sentence "Lean … does not export it for private
  declarations" is true only of the `.olean`/`.olean.server` parts of
  `module` files and should be reworded. Consequence: the hook is the
  author-time guard, and the inspector re-judges `private` from the name
  (`isPrivateName`, which the reader already reports) — exactly the "never
  trusts the hook" rule, now load-bearing for this case too. Not measured
  for a `module` concept file, because one cannot exist over this LaxCore:
  `lake build ConceptsTaggedModule` → `error: cannot import non-`module`
  LaxCore from `module`` (`tagged-module-build`, exit 1). A header-less
  LaxCore is therefore also a hard "no module headers" for every spec-2
  package, which is decision 7 restated.
- **`lake update LaxCore` runs every package's post-update hook**: adding
  the require cost 16.89 s because mathlib's `cache get` ran again (no
  files to download; `lake-update-laxcore`). Only the LaxCore entry changed
  in the manifest (diffed). Stage 1's warm-workspace seeding should expect
  the hook on every manifest change.

**The comparator over tagged statements.** `comparator-tagged.json` names
`CertTagged.pa`/`CertTagged.pf` over `ChallengeTagged`/`SolutionTagged`:

| tag | command | result |
|---|---|---|
| `tagged-comparator` | `lake comparator --config comparator-tagged.json` (sandboxed, LaxCore as `path = "../laxcore"`) | **exit 1, 0.13 s**: `error: LaxCore: package directory not found: …/project/../laxcore`, `error: Child exited with 1` — fails in "Resolving dependencies" |
| `tagged-comparator-nosandbox` | `… --inadvisably-no-sandbox` | **exit 0, 9.15 s**, `Your solution is okay!` |
| `tagged-comparator-git-sandboxed` | require switched to `git = "file:///…/scratchpad/laxcore-git"`, `rev = a7fb4b3…` (`lake update LaxCore` 8.45 s, materialized into `.lake/packages/LaxCore`; `tagged-build-git` 2.34 s), then `lake comparator --config comparator-tagged.json` sandboxed | **exit 0, 9.57 s**, `Your solution is okay!` |

So the tag attribute and its hook are invisible to the comparator, as they
should be (LaxCore is not in the certificate's cone; the export list is the
same 34 primitives + 2 theorems as for the plain pair). The exit-1 run is a
sandbox fact, not a comparator one: `Lake/CLI/Check.lean` binds `/`
read-only, covers `/home`, `/root`, `/run/user`, `/tmp` with tmpfs, then
binds back only `projectDir`, the toolchain sysroot and Lake's home. A path
require outside `projectDir` (anything under `/home` that is not the
project) does not exist inside the sandbox; a git require materialized
under `projectDir/.lake/packages/` does. For stage 3 this costs nothing
(container B runs `--inadvisably-no-sandbox`; the container is the
sandbox), but for stage 4's `lax certify --run` on an author's machine the
generated project must reference LaxCore and the concept packages as git
requires (or path requires *inside* the project directory), and `~/.lax/warm`
is likewise invisible to the sandboxed run. After the measurement the
lakefile and manifest were restored to the path require (copies of both
variants in `logs/lakefile-*-require.toml.txt`,
`logs/lake-manifest-*-require.json.txt`), `.lake/packages/LaxCore` removed,
and `lake build ConceptsTagged SolutionTagged` re-run (exit 0,
`tagged-build-restored`); the scratch git repo lived in the session
scratchpad and is not part of the spike.

### Verdicts

1. Header-less Challenge/Solution: **GO** — accepted in 8.4–8.5 s, the
   unfolded-conclusion negative rejected with the same message as the
   `module` pair, and a header-less certificate over `module`-style
   concepts accepted too.
2. Attribute as data: **GO** — a core-only executable with `loadExts :=
   false` lists the tagged names from `ModuleData.entries` under
   `LaxCore.laxStatementAttr` (entries are `Name`), the hook's five
   negatives fail with the intended messages, and the comparator accepts
   the tagged statements (9.2 s no-sandbox, 9.6 s sandboxed with a git
   require). One correction to the plan: for header-less files a `private`
   tagged def *is* exported, so the inspector's own `private` check, not
   Lean's olean filter, is what enforces that rule.
