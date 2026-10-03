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
