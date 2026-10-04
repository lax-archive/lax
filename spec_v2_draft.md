# Status

This file is the **draft of spec version 2**, written 2026-10-03 alongside
stages 2–3 of `axiomfree-plan.md` for Jan to reconcile. It is not normative:
`spec.md` (spec version 1) remains the rule of every environment admitted so
far. Spec version 2 is the rule of the ``v4.35.0`` environment, the next
epoch; ``v4.33.0`` stays spec version 1 and closes to new records when the
epoch flips (plan, decision 1). The two proof networks never interact,
because environments never depend on each other.

The text below is `spec.md` with the spec-2 changes applied and left verbatim
elsewhere. The sources of every rule are `axiomfree-plan.md` (Decisions,
Design, Stages), `spike/axiomfree/REPORT.md` (the measured facts), and the
current `spec.md`. Where the plan is silent the draft says so in a
`> draft note:` block rather than inventing; each such block names the
options.

**Sections rewritten:** Archive Environments; manifest.yaml (the
`specVersion` rule and the example); Packages (the libraries rule, the
import rule, the examples); Concepts; Proofs; Annotations; Archive Database
(the archive-schema `specVersion` remark, the `statements` entries, the
`proofs` entries, the new `certificate` block, the determinism paragraph);
The Built Environment: A Primer (one paragraph); Build Pipeline (Static
validation's libraries rule, Provision, Replay's closing sentence, Inspect,
the new Certify phase, Paper's concurrency window, Emit, the trust chain,
the container limits); Inspection Scaffolding;
Inspection Internals; the new Certification subsection with the worked
example; Site Generator; CLI (`lax init`, `lax build`, `lax port`, the new
`lax certify`, `lax doctor`); GitHub Actions (validation isolation, the
bundle); Distribution and Deployment (admission).

**Sections verbatim:** Vision; Concepts and Proofs; Versioning; File
Structure; Namespaces; Papers; The Archival Layer; Lifecycle; Successors;
Actions; Implementation (the list); Database Repository; Environment
variables; Tests; The Social Layer.

**Not in this draft:** the concept dialect (`spec_conceptdialect.md`) stays a
separate project and spec 2 does not depend on it — see the note in Concepts.


# Vision

The archive shall serve as the social and archival layer for automated Lean
formalization.

**Social:** Lean's kernel checks proofs for free, but it cannot check whether
a formal statement means what it claims to mean. The archive aims to provide the
missing trust: reviewers can publicly endorse formalizations as faithful,
staking their names on them. 

**Archival:** what arXiv is to preprints, the archive shall be to formalized
mathematics: a decentralized network of independent citable submissions
building on top of each other.

This document describes an absolutely minimal version of this product.
Everything non-essential is postponed to later. At the same time, we try to get
those things right that cannot be easily changed later.


## Concepts and Proofs

The archive's content comes in two kinds.

A **concept** pairs a well-defined mathematical object presented in natural
language (a definition or claim as it would appear in a paper),
with a faithful encoding of that object in Lean. Crucially, concepts contain no
proofs: they carry exactly the information needed to pin down the semantics of
a natural-language statement or definition within Lean, and nothing more.
Concepts are especially clean Lean code written for and in collaboration with
humans.

A **proof** is ordinary Lean code certifying a claim made by a concept. Since
the kernel checks its correctness, writing proofs can be outsourced entirely
to AI agents without compromising trust.

A **submission** is a single citable unit of work containing concepts and
proofs. The two are decoupled: a submission may leave its own proof
obligations open, and may discharge obligations of other submissions.


## Versioning

Unlike most software projects where code freely changes over time, submissions
are frozen in time. This makes it possible to build upon and cite previous
submissions, allowing the organic growth of a dependency network mirroring that
of scientific publications. We understand that this brings along its own
problems, which we believe are worth it. In particular, we pin the version of
Lean, Lake and mathlib. A new version of a submission is a new submission
that supersedes the old one (see Successors).



# Submission Layout

This section gives the full rule set that all submissions in the archive must
adhere to.

Each submission carries two central files in the root folder:
``manifest.yaml``, written by the authors, and ``build-output.json``, derived by
the build.

## Archive Environments

An **archive environment** is an immutable Lean toolchain together with a
pinned set of **libraries**, identified by its Lean version string, which is
also the name of the mathlib release tag whose commit it records. Every
environment is governed by exactly one **spec version**: the content rules its
records follow. This document is spec version 2, the rule of ``v4.35.0``;
``v4.33.0`` and ``v4.30.0`` follow spec version 1, whose text stays in force
for their records. A spec version never changes under an environment, so a
record's rules are as frozen as its pins. The archive admits a table of
environments. Exactly one is the **epoch**: the environment the archive
recommends, the one ``lax init`` uses unless ``--env`` names another. An
environment may later be closed to new records; a closed environment stays
in the table so that its existing records remain reproducible.

| id | spec | Lean toolchain | mathlib revision | status |
| --- | --- | --- | --- | --- |
| ``v4.35.0`` | 2 | ``leanprover/lean4:v4.35.0`` | *the commit of mathlib's ``v4.35.0`` tag* | active, epoch |
| ``v4.33.0`` | 1 | ``leanprover/lean4:v4.33.0`` | ``db584cd6d46c92f209a44c0f1c829460d327499d`` | closed at the epoch flip |
| ``v4.30.0`` | 1 | ``leanprover/lean4:v4.30.0`` | ``c5ea00351c28e24afc9f0f84379aa41082b1188f`` | closed 2026-09-12 |

The libraries of a spec-2 environment, each pinned to one commit of its
canonical repository and present in **every** submission workspace of that
environment:

- ``mathlib`` (required) — ``https://github.com/leanprover-community/mathlib4``
  at the mathlib revision of the row;
- ``LaxCore`` (required) — ``https://github.com/lax-archive/lax-core``, the
  one-module library declaring the ``lax_statement`` attribute (see
  Concepts); it imports only ``Lean``, so one commit serves every environment,
  and the row pins it like mathlib;
- ``CSLib`` (allowed) — the commit chosen against the row's mathlib at
  admission.

> draft note: the ``v4.35.0`` row — the mathlib tag commit, the ``LaxCore``
> commit, the ``CSLib`` commit and repository URL, and the closure date of
> ``v4.33.0`` — is filled in at admission (plan, stage 6). The spike measured
> ``v4.35.0-rc3`` (mathlib ``c55e6e786f49471c72fbddbec5415808896aec1e``), not
> a final tag. Whether ``CSLib`` is allowed or required is the plan's open
> decision 1; this draft takes "allowed", as the plan assumes.

A closed environment remains supported only for records created before its
closure date, including init records which had not yet selected an
environment on that date. Closing an environment never invalidates those
existing submissions.

A submission selects exactly one environment through ``leanVersion`` and
``mathlibVersion``. Only submissions in the same environment may depend on one
another. Porting existing work to another environment therefore creates a
successor submission (see Successors); it never rewrites the original record.
A port from a spec-1 environment into ``v4.35.0`` also rewrites the content
to this spec's rules (see Concepts, Proofs, and ``lax port``).

The following settings are fixed per environment. For a spec-2 environment
they are:

- ``specVersion: "2"``
- trusted background imports
    - the environment's libraries, each from its canonical repository, pinned
      to the row's commit, and present in **every** submission workspace.
      Importing a library remains the author's choice — presence without
      import is inert. (A concept package that declares statements imports
      ``LaxCore``.)
- concept build options
    - ``autoImplicit`` off
- proof build options
    - ``autoImplicit`` off
- trusted validation sandbox
    - stock image ``node:22-bookworm-slim@sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066``
      with the selected environment's pinned host toolchain and warm
      workspace — the three libraries built — mounted read-only
    - for a declared paper, the stock image
      ``texlive/texlive:TL2025-historic@sha256:f25ee2dcd00f58198f918064f4a1c8562410b33e84155bd55b02b419d73d9391``
      with none of the Lean mounts, and the pinned ReflowTeX fork
      (``lax-archive/reflowtex``) for the derived web view
- allowed background axioms
    - ``propext``
    - ``Classical.choice``
    - ``Quot.sound``
- certification kernels: the kernel set the environment's ``lake comparator``
  runs on every submit (see Certification). For ``v4.35.0`` at admission:
  Lean's own kernel alone. The set may grow by a table edit; the record of
  every certification names the kernels that ran.

> draft note: the plan fixes "Lean's kernel alone to start" and leaves the
> full set to the Lax17 port's measurement (open decision 2). The spike
> measured ``--paranoid`` at 3–9 ms per declaration of the cone and ``nanoda``
> as the memory hog, so the setting is a per-environment table value, not a
> spec constant.

For a spec-1 environment the settings are those of spec version 1: one
background import (mathlib), statements as axioms, and no certification.


## File Structure

A submission rooted at folder ``mysubmission`` with id ``lax-261`` **must**
have the following layout.

    mysubmission/
      manifest.yaml
      abstract.md
      LICENSE
      concepts/                    
        lakefile.toml
        lean-toolchain
        Lax261.lean                -- root module of the concept package
        Lax261/...                 -- modules of the concept package
      proofs/                      
        lakefile.toml
        lean-toolchain
        Lax261Proofs.lean          -- root module of the proof package
        Lax261Proofs/...           -- modules of the proof package
      paper/                       -- optional, declared in the manifest
        main.tex

Additional Rules:

- **License.** The file ``LICENSE`` in the submission root folder must contain
  an accepted license, matched against the canonical text after whitespace
  normalization. One optional final line of the form ``Copyright YYYY[-YYYY]
  NAME`` is ignored. For the MVP we accept exactly one license: the **Apache
  License 2.0**, the license of Lean and mathlib.

- **Abstract.** ``abstract.md`` must be non-empty. It is rendered as markdown,
  with inline math delimited by ``$...$`` or backticks, and shown prominently
  on the website.

- **Files.** ``build-output.json``, ``lake-manifest.json``, ``.lake/``, Lake
  package-overrides files, and the generated ``paper.pdf`` and
  ``paper-web.tar`` must not be checked in. Generated files left by a local
  build are fine. Extra root-level documentation is allowed but is not
  submission content; undeclared files inside either package are rejected. A
  local build additionally tolerates entries that the repository's own ignore
  rules cover, since no commit can carry them.

- **Limits.** A repository may contain at most 100,000 regular files totalling
  2 GiB and no symlinks or special files. ``manifest.yaml``, ``LICENSE``, and
  each lakefile are limited to 256 KiB, ``abstract.md`` to 1 MiB, and
  ``lean-toolchain`` to 1 KiB. Titles have at most 200 Unicode characters and
  512 UTF-8 bytes; manifests have at most 100 authors and 1,000 bibliography
  strings of 16 KiB each; each package has at most 200 requirements. Displayed
  concept source files are limited to 4 MiB. A paper folder is limited to
  50 MiB and 2,000 files, its PDF to 25 MiB and 500 pages, and its derived
  web bundle to 25 MiB.

## manifest.yaml

The file ``manifest.yaml`` must contain the following keys and adhere to the
following rules.

- ``specVersion``: version of the spec this submission adheres to
- ``mathlibVersion``: version the submission was built against
- ``leanVersion``: version the submission was built against

- ``id``: The submission's unique id, ``lax-N`` for a positive natural number
  N written without leading zeros. ``lax init`` draws a random six-digit N on
  the author's machine; the first ``lax submit`` binds it to the archive (see
  Actions). The legacy spelling ``LaxN`` is accepted and normalized. Ids are
  deliberately opaque; this prevents the squatting of nice names like
  ``RamseyTheory``.

- ``title``: A non-unique title, like the title of the paper the submission formalizes.

- ``authors``: An ordered, possibly empty, list of author entries. Each entry is a
  tuple with a required ``name`` (display name) and optional ``orcid`` and
  ``github`` identifiers. Used for credit only, not rights-management.

- ``bibEntries``: a possibly empty list of strings. Each string contains one
  or more structurally complete BibTeX entries, as in a ``.bib`` file.

The following keys are optional:

- ``issue``: the submission's authoritative GitHub issue, as ``repositoryId``
  and ``number``. ``lax submit`` writes it when it creates the issue; every
  later submit must carry it, and trusted validation requires it to match the
  issue the command arrived on.

- ``supersedes``: the id of the registered submission this one replaces, see
  Successors.

- ``unlisted`` and ``anonymous``: booleans, ``false`` when absent.
  ``unlisted: true`` asks discovery surfaces (the landing list, search) to omit
  the submission while its pages stay addressable. ``anonymous: true`` asks
  presentation surfaces to suppress author attribution and source-repository
  links. Both are presentation policy, not access control: the manifest, the
  source location, and the owner list remain public.

- ``paper``: a LaTeX paper the archive compiles and shows beside the
  submission, see Papers. ``folder`` is a directory inside the submission
  (``.`` allowed), ``main`` a regular file inside it, ``engine`` one of
  ``pdflatex`` (default), ``lualatex``, ``xelatex``, and ``web: false`` opts
  out of the derived web view.

- ``initialOwners``: a list of GitHub handles that ``lax owners`` stores
  before the submission has an issue. The first submit resolves them into the
  owner list and removes the key.

Additional Rules:
- ``specVersion`` is the string ``"1"`` or ``"2"`` and must equal the spec
  version of the selected environment. For new Archive records,
  ``leanVersion`` must name an active archive environment; a record predating
  an environment's closure may retain that closed environment.
  ``mathlibVersion`` must equal the selected environment's mathlib revision.
  The full Lean toolchain name appears only in the ``lean-toolchain`` files
  and must equal the selected environment's toolchain. The other library pins
  do not appear in the manifest: they are fixed by the environment and
  checked in the lakefiles (see Packages).
- All scalar manifest fields are YAML strings, not numbers or other scalar
  types, except the two booleans and the two numbers under ``issue``.
- No keys beyond the ones listed here are allowed.

Example:

    specVersion: "2"
    id: lax-261
    issue:
      repositoryId: 1320232165
      number: 261
    leanVersion: "v4.35.0"
    mathlibVersion: "<the 40-character commit of mathlib's v4.35.0 tag>"
    title: My Submission
    authors:
      - name: Alice Smith
        orcid: "0000-0002-1825-0097"
        github: alice
      - name: Bob
        github: bob
    bibEntries: []



## Packages

Each submission ``lax-261`` contains two Lake packages: a **concept
package** ``Lax261`` containing its concepts and a **proof
package** ``Lax261Proofs`` containing its proofs.

We only allow ``lakefile.toml``, never ``lakefile.lean``, and enforce the
following rules:

- **Whitelisted keys only.** The file may contain exactly the keys shown in
  the examples below: ``name``, ``defaultTargets``, the archive environment's
  build options, ``[[require]]`` entries (exactly ``name``, ``git``, ``rev``,
  optionally ``subDir`` — or ``name`` and ``path`` for the proof package's
  own concept package), and one ``[[lean_lib]]`` (exactly ``name``).

- **Fixed names.** The package name and the name of the single ``lean_lib``
  are both ``Lax261`` in the concept package and both ``Lax261Proofs`` in
  the proof package. The lib is the only default target. With Lake's default
  layout, module files therefore live under ``Lax261/`` and
  ``Lax261Proofs/`` respectively.

- **Libraries.** Each package **must** require every *required* library of
  its environment and *may* require every *allowed* one — under the
  library's fixed name, from its canonical URL, pinned to the environment's
  commit, with no ``subDir``. For ``v4.35.0`` that is ``mathlib`` and
  ``LaxCore`` in every package and ``CSLib`` at the author's choice. A
  library at another revision or URL, or a library the environment does not
  list, is a violation. Every other git require is a submission.

- **Dependencies.** Besides the libraries, concept packages may require only
  concept packages; proof packages may require both concept and proof
  packages. We issue a warning whenever a proof package is required.
  A proof package need not depend on its own concept package; it may prove
  only conjectures from unrelated submissions.
  Concept and proof packages of other submissions are added by pinning the
  full lowercase 40-character commit SHA and subfolder of the submission's
  repository. Every such
  require resolves by name: by the fixed-names rule the require name is the
  required submission's package name and thereby names a record in the
  database (which keeps two submissions at different folders of one commit
  apart). The require's ``(git, rev, subDir)`` must equal that record's
  current source — ``repository``, ``commit``, and ``folder`` joined with
  ``concepts`` or ``proofs`` — verbatim. The required submission must be in
  the same archive environment. Write the canonical ``repository`` spelling
  (see ``lax submit``), not an ssh alias of it. The required submission
  must be registered; a require on a draft is a violation (see Lifecycle).
  The archive does not accept cross-submission path requirements:
  multi-submission work is committed, submitted, and registered bottom-up,
  with each dependent pinning the preceding submission's exact Git commit.
  The only path exception is the proof package's own concept package via
  ``../concepts``. A local ``lax build --nonstrict`` additionally admits a
  ``path`` require on a **sibling**, another unregistered submission checked
  out beside this one, so that a chain can be built before its members have
  commits (see CLI). The transitive Archive dependency graph must be acyclic.

- **Imports.** A module may import only modules of its own package, of Lean
  core (``Init``, ``Std``, ``Lean``), of the environment's libraries its
  package requires, and of the packages its package requires. Modules of a
  library's own dependencies (mathlib's ``Batteries``, ``Aesop``, ``Qq``, …)
  are not importable; import the corresponding library module instead.
  Enforcement is a prefix check on each module's imports as
  recorded in the built environment: by the fixed-names rule, every archive
  module name begins with its package name, so an import's first component
  identifies its package. (An import of a module absent from the workspace
  never reaches this check — it already fails Compile.)

- **Root modules.** Each package has a root module: ``concepts/Lax261.lean``
  in the concept package, ``proofs/Lax261Proofs.lean`` in the proof
  package. Three rules govern it, each checked from the built environment:
  it imports exactly the other modules of its package, it declares
  nothing, and it carries no module docstring. The first makes the default
  target build the whole package; the other two make the root a table of
  contents rather than content — in particular, not a concept. Write it as
  the scaffold does and as mathlib writes ``Mathlib.lean``: one ``import``
  line per module, nothing else. Residue the environment cannot see (a
  comment, a stray ``#check``) is tolerated. One caveat on "exactly": a Lean
  module without imports implicitly imports ``Init``, so the root module of an empty
  package records that single import, which the check ignores.

- **Empty submission.** A submission may contain no concepts and no proofs.

- **Pinned toolchain.** ``lean-toolchain`` contains exactly the submission
  environment's toolchain followed by one newline.

- **Builds.** Both packages must build: ``lake build`` succeeds in
  ``concepts/`` and in ``proofs/``. Lean warnings do not fail a submission.

- **The manifest is derived.** ``lake-manifest.json`` is a lax-generated
  file, like ``build-output.json``. ``lax init`` seeds both packages from the
  pinned warm workspace, and ``lax build`` refreshes the manifests
  from the validated dependency closure (see Build Pipeline, Provision). They
  are never authored or committed. Authors do not run ``lake update``; plain
  ``lake build`` follows the generated manifest.

Example ``lakefile.toml`` of a concept package:

    # mysubmission/concepts/lakefile.toml
    name = "Lax261"
    defaultTargets = ["Lax261"]

    [leanOptions]
    autoImplicit = false

    # mandatory: the environment's required libraries at its pins
    [[require]]
    name = "mathlib"
    git = "https://github.com/leanprover-community/mathlib4"
    rev = "<the commit of mathlib's v4.35.0 tag>"

    [[require]]
    name = "LaxCore"
    git = "https://github.com/lax-archive/lax-core"
    rev = "<the LaxCore commit of the v4.35.0 row>"

    # optional: an allowed library, at the environment's pin
    [[require]]
    name = "CSLib"
    git = "<the canonical CSLib repository>"
    rev = "<the CSLib commit of the v4.35.0 row>"

    # concept package of another submission this one builds on
    [[require]]
    name = "Lax42"
    git = "https://github.com/alice/othersubmission"
    rev = "0123456789abcdef0123456789abcdef01234567"
    subDir = "concepts"

    [[lean_lib]]
    name = "Lax261"

Example ``lakefile.toml`` of the corresponding proof package:

    # mysubmission/proofs/lakefile.toml
    name = "Lax261Proofs"
    defaultTargets = ["Lax261Proofs"]

    [leanOptions]
    autoImplicit = false

    [[require]]
    name = "mathlib"
    git = "https://github.com/leanprover-community/mathlib4"
    rev = "<the commit of mathlib's v4.35.0 tag>"

    [[require]]
    name = "LaxCore"
    git = "https://github.com/lax-archive/lax-core"
    rev = "<the LaxCore commit of the v4.35.0 row>"

    [[require]]
    name = "Lax261"
    path = "../concepts"

    # discouraged, but allowed: reusing another submission's proofs
    [[require]]
    name = "Lax42Proofs"
    git = "https://github.com/alice/othersubmission"
    rev = "0123456789abcdef0123456789abcdef01234567"
    subDir = "proofs"

    [[lean_lib]]
    name = "Lax261Proofs"

> draft note: the require names ``LaxCore`` and ``CSLib`` are the plan's
> spellings; the fixed name of a library is whatever its own lakefile
> declares (mathlib's is ``mathlib``), so the final spellings follow the two
> repositories at admission. The plan does not say whether a proof package
> must require ``LaxCore``; this draft requires it in both packages because
> "required" is a property of the library, not of the package, and the
> marker in a proof package is a violation regardless.

## Namespaces

Each submission with id ``Lax261`` owns two top-level namespaces: its concepts 
live in ``Lax261`` and its proofs in ``Lax261Proofs``. 

The rule is the composition rule, and nothing more: a relative certificate
imports many records' packages into one Lean environment, and Lean refuses
two modules that declare the same constant (unless both are theorems of
identical name, type, and level parameters — ``finalizeImport``'s
tolerance for realized names). A prefix the record owns is the one local
condition that guarantees composition with records that do not exist yet.
The test applies to every constant a package contributes, on the name as
the olean persists it, and the only exemptions are ones Lean's own
mechanisms vouch for — never the shape of a name. The inspector reports
each declaration's **origin** with its evidence: ``authored``; ``private``
with the module Lean mangled it with (``_private.<module>.0.…``);
``scoped`` with the module whose macro scopes it carries
(``…._@.<module>._hyg.<n>``); ``realized`` with the imported constant it
was realized under (``f.congr_simp``, ``f.eq_def``, ``f.eq_<n>``, a
matcher's ``splitter`` and equations — reserved names Lean persists under
the rewritten function's namespace and regenerates identically wherever
they are needed); and ``auxiliary`` with the package's own declaration it
was generated for (``S.rec``, ``S.casesOn``, ``f.match_1``, ``f.proof_1``),
whose name extends its parent's and so carries the parent's prefix. Exempt
from the prefix test, and from nothing else, are a ``private`` or
``scoped`` name of one of the package's own modules, and a ``realized``
**theorem**: two records that both realize ``f.eq_def`` can be imported
together because Lean admits identical theorems twice. A realized
*definition* under an imported name (``bv_decide``'s
``<enum>.enumToBitVec``) is refused, because two records carrying it cannot
be imported together. A name that merely looks generated — ``proof_1``,
``eq_1``, a leading underscore — is authored unless the olean says
otherwise, and is held to the prefix like any other.

Two things names cannot see are rules of their own. A record declares no
``initialize`` and none of its sugar (``register_option``,
``register_simp_attr``, ``declare_syntax_cat``, a persistent environment
extension): such a registry is keyed by a name the namespace rule cannot
see, and two records choosing the same one cannot be imported together.
And every ``syntax``, ``notation``, ``macro``, ``macro_rules``, and ``elab``
a record declares is ``scoped`` or ``local``: a global one rewrites every
importer, the archive's generated Challenge included. The inspector reads
both facts from the olean's extension entries with extensions disabled.
The rule is not the whole defence for the second: the certificate is also
held to the archive's reading of each edge (see Certification).

A name is also held to what a reader can read. The archive's canonical
form of a name is its dot-separated components, nothing escaped; a name
whose components do not round-trip through that form — a ``.`` inside a
component, a numeric component outside Lean's private mangling — is
written escaped by the inspector and refused as an endpoint, since
``Lax1.C.«A.B»`` and ``Lax1.C.A.B`` would otherwise read as one constant.
Every user-level name is NFC, carries no combining mark or invisible format
character, and uses one script per component (lower-case Greek beside
Latin excepted): a Greek capital in a Latin word, or a Cyrillic letter, is
refused, because the Challenge text is the audit surface and a lookalike
would read as the real statement. Within one package a name is declared
once; a name two modules both declare is refused unless both copies are a
realized theorem, which Lean merges.

## Concepts

A **concept** is a Lean module of the concept package; every module except the
root module is one, and must carry the concept annotation (see Annotations).
The concept ``Myconcept`` of submission ``Lax261`` is the module
``Lax261.Myconcept``, stored at Lake's canonical path
``concepts/Lax261/Myconcept.lean``. Concepts cannot be nested in subfolders.

The **statements** of a concept are the definitions whose module of origin
it is that carry the ``lax_statement`` attribute, declared by ``LaxCore``:

    @[lax_statement] def Ramsey : Prop := ∀ r s : ℕ, ∃ n, …

A statement is a claim: a closed proposition, *defined*, never asserted.
Nothing in the archive asserts anything — a proof concludes a statement from
the statements it assumes, and the kernel checks that step (see Proofs). The
attribute is the whole marker: it is applied at the definition site, where a
reviewer reads it, and Lean refuses a tag attribute from any other module.

Rules for a statement:

- **Definition kind.** A statement is of definition kind — the kernel's
  notion, so ``abbrev`` qualifies (and so would an ``instance``, which is a
  definition to the kernel) while ``theorem``, ``axiom``, and ``opaque`` do
  not.

- **Closed proposition.** Its stored type, metadata stripped and without any
  reduction, is literally ``Sort 0`` (``Prop``). It has no binders:
  parameters go inside the body with ``∀``. A ``def`` whose type merely
  reduces to ``Prop``, or that takes an argument, is not a statement and the
  marker on it is a violation. Universe parameters are allowed
  (``@[lax_statement] def X.{u} : Prop := ∀ α : Type u, …``).

- **Not private.** A ``private`` definition cannot be named by the packages
  that depend on it; the marker on one is a violation.

- **The hook is a courtesy.** ``LaxCore``'s attribute carries a validation
  hook that rejects a non-definition, a non-``Prop`` type, binders, and
  ``private`` at the author's elaboration with a clear message. The archive
  re-judges every rule above from the built environment and never relies on
  the hook (see Inspection Internals).

- **Auxiliaries.** A ``Prop``-valued definition without the marker is an
  **auxiliary**: ordinary concept content, never an endpoint of an edge of the
  proof network. The marker decides, not the shape: ``@[lax_statement] def
  AimpC : Prop := A → C`` is a statement like any other, and a proof of it is
  the edge ``{} → AimpC``, not ``{A} → C``.

- **Only in concept packages.** The marker on a declaration of a proof
  package is a violation.

A concept owns its module name as a namespace: every name the module declares
carries the module name as a prefix, e.g. ``Lax261.Myconcept.Ramsey``. This
one prefix condition is the whole rule — deeper subnamespaces are
automatically fine.

A concept may import modules of the environment's libraries and other
concept modules (of the same or of other submissions). These imports form the
**concept DAG** (acyclic for free, since Lean imports are).

Additional Rules:

- **No axioms.** The ``axiom`` declaration kind is a violation anywhere in the
  concept package: spec 2 has no archive axioms, and a submission that
  declares one has misunderstood the rule, not found a loophole. This, and
  the rule that every declaration's axiom set is within the background
  three (so no ``sorry`` anywhere), are archive standards: the correctness
  of an edge comes from the judge alone, which re-checks the edge's whole
  cone, and a helper with ``sorry`` that no edge uses is harmless to the
  graph — and misleading to a reader, which is why the standard is a hard
  rejection and not a warning.

- **Axiom-free.** The axiom set (``#print axioms``) of every declaration of
  the concept package is a subset of the archive environment's three
  background axioms. ``sorryAx`` and the native-computation axioms
  (``Lean.ofReduceBool``, ``Lean.ofReduceNat``) are not background. Since
  statements are definitions, they never appear in an axiom set: a concept
  that *uses* a statement unfolds a definition, which is fine for an
  auxiliary and is what ``AimpC`` above does.

The concept dialect (``spec_conceptdialect.md``) is a separate project: a
whitelist of the Lean a concept package may be written in, enforced by a
parser. Spec 2 does not depend on it; a spec-2 concept package is any Lean
that passes the rules above. If the dialect lands, its declaration and
attribute whitelists must admit ``@[lax_statement]`` and ``def … : Prop`` and
drop ``axiom``, which the dialect today lists as allowed.

## Proofs

A **proof** is a theorem-kind declaration of the proof package whose stored
type is a chain of statement constants: zero or more hypotheses, each a
statement, ending in a statement, the proof's **conclusion**:

    theorem Q (h₁ : S₁) (h₂ : S₂) … (hₖ : Sₖ) : C := …

Every other declaration of the proof package is a **helper**, which is not
archive content. There is no annotation that makes a proof: proof-hood is
read off the type, and the hypotheses *are* the assumptions. Precisely, the
declaration's type, metadata stripped and without any reduction, is a
sequence of ``k ≥ 0`` ``∀``-binders whose domains are constants
``S₁ … Sₖ``, ending in a constant ``C``, where every ``Sᵢ`` and ``C`` is a
statement of a concept package the proof package requires, or of its own
concept package.

Rules:

- **Theorem kind.** A proof must be of theorem kind — the kernel's notion,
  not the surface syntax, so mathlib's ``lemma`` qualifies. A definition
  whose type has the shape above is a helper.

- **Statement constants, literally.** Every domain and the conclusion is the
  statement constant itself. A type that is definitionally but not
  syntactically equal to a statement — the statement's body written out, a
  helper that unfolds to it, ``A ∧ B`` where ``A`` and ``B`` are statements
  — makes a helper, not a proof: the certificate (see Certification)
  compares statements structurally, so the archive demands the constant. To
  prove the body, prove the constant; to prove ``A ∧ B``, declare the
  conjunction as a statement or prove ``A`` and ``B`` separately.

- **Required packages only.** A statement of a package the proof package does
  not require directly — one reachable only transitively through another
  require — does not qualify: to assume or conclude a statement, require its
  package. A theorem of proof shape over such a statement is a violation,
  not a helper, since the shape announces an edge the archive cannot record.

- **Binders.** Binder names and binder info (explicit, implicit, instance)
  are irrelevant to proof-hood and are recorded only so the generated
  certificate can apply the proof with ``@``. A hypothesis the proof never
  uses is still an assumption. A section ``variable`` that the elaborator
  dropped because the body never mentions it is not a binder, and so not an
  assumption; a conditional proof written with ``variable`` says ``include``.

- **Edges.** A proof is the hyperedge ``{S₁ … Sₖ} → C`` of the proof network.
  Duplicate hypotheses collapse in the edge but keep their positions in the
  **telescope**, the ordered binder list the build records. ``k = 0`` is an
  unconditional proof. A self-edge (``C`` among the hypotheses) is a proof
  like any other and grounds nothing.

- **Universes.** Every statement constant in the chain is instantiated with
  universe *parameters of the proof* — never with a concrete level, a
  successor, or a ``max``. The conclusion is instantiated with pairwise
  distinct parameters, so a proof concludes the statement in full
  generality; a hypothesis may repeat a parameter, which only strengthens the
  edge. Thus every edge is universally quantified over universes and
  composing edges by name alone is sound; the generated certificate theorem
  copies the proof's universe parameters. ``theorem Q.{u} (h : A.{u}) :
  C.{u}`` is a proof; ``theorem Q (h : A.{0}) : C.{0}`` is a violation.

> draft note: the plan states the universe rule for "every statement
> constant in the chain" without distinguishing conclusion from hypotheses.
> The distinct-parameters condition on the conclusion is this draft's
> addition: a proof of ``C.{u,u}`` does not prove ``C.{u,v}``, so without it
> a name-only network would call ``C`` proven on a special case. Options: as
> drafted; or require pairwise distinct parameters everywhere (simpler to
> state, rejects nothing a real proof needs); or require the proof's level
> parameters to be exactly the conclusion's instantiation.

- **Not private.** A ``private`` theorem of proof shape is a violation: the
  certificate must name it, and a mangled name cannot be named from another
  module.

> draft note: the plan is silent on ``private`` proofs. The alternative is
> to classify one as a helper; this draft prefers the loud failure because
> the shape announces an intent the archive would otherwise drop silently.

- **Helpers.** Any other declaration — theorems of other shapes, definitions,
  instances, structures — is a helper. A helper may carry an ordinary
  docstring; a helper whose docstring carries yaml frontmatter is a violation
  (see Annotations), so a spec-1 proof ported without its type being
  rewritten fails loudly instead of silently becoming a helper.

- **No axioms, axiom-free.** The ``axiom`` declaration kind is a violation
  anywhere in the proof package. The axiom set of every declaration of the
  proof package — proof or helper — is a subset of the three background
  axioms; ``sorryAx`` and the native-computation axioms are not background.
  A statement never appears in an axiom set, because it is a definition: the
  only way to rest on an unproven statement is to assume it as a hypothesis,
  which is visible in the type and recorded as an edge. Both rules are
  archive standards (see "The three questions"): the judge re-checks every
  edge's whole cone and refuses a ``sorry`` or a stray axiom there on its
  own; what the standard adds is the helper no edge reaches, which is
  harmless to the graph and misleading to a reader.

- **Namespace.** Every name declared in the proof package carries the
  prefix ``Lax261Proofs``, as for concepts.

- **Unused helpers.** A user-level helper of theorem kind that no proof of
  the package uses, directly or transitively, produces a warning
  (``unused-lemma``), never a violation.

Together, the proofs weave the statements of the archive into the **proof
network**: the directed hypergraph over all statements with a hyperedge
(A → c) for every proof with hypothesis set A and conclusion c. A statement
is **proven** if it is the conclusion of some proof all of whose hypotheses
are (recursively) proven, and **unproven** otherwise — a least fixed point,
so statements in a dependency cycle do not prove each other. More generally, a
statement is **proven relative to** a set C of statements if it becomes
proven once the statements in C are taken as proven. Every edge of the
network is certified by the kernel independently of the archive's own
reading of the environment (see Certification), and any derivation the
network admits — a statement proven, or proven relative to a set — can be
exported as a standalone certificate that composes the edges' proofs by
application (see ``lax certify``).

A conditional proof assumes its hypotheses as ordinary Lean hypotheses, so
the hypotheses of many proofs are conveniently shared through a section:

    import Lax42.Colorings
    import Lax261.Myconcept

    namespace Lax261Proofs

    section
    variable (hA : Lax42.Colorings.Somestatement)
    include hA

    theorem Q : Lax261.Myconcept.X := …          -- edge {Somestatement} → X

    theorem R : Lax261.Myconcept.Y := …          -- edge {Somestatement} → Y
    end

    end Lax261Proofs

The ``include`` is what puts ``hA`` into both types; without it a proof that
does not mention ``hA`` would be unconditional, which is correct and, for an
author who meant to assume it, surprising.

## Annotations

We annotate concepts; proofs are described. A concept is annotated by exactly
one module docstring ``/-! … -/``. A proof may carry the usual docstring
``/-- … -/``, which is its description.

The concept annotation is a docstring that we parse as markdown with yaml
frontmatter (a common pattern from static site generators). The markdown
after the frontmatter is the description. Top-level ``#`` headings split out
named sections; a section titled ``Description`` supplies the description
when present. Inline math may use ``$...$`` or backticks; an invalid
expression is shown verbatim rather than dropped. The frontmatter grammar is
a fixed minimal subset of yaml — scalar ``key: value`` lines — because it is
parsed by the inspector in core-only Lean (see Inspection Scaffolding);
anything beyond the subset is a build error, never a guess. The recognized
keys are:

Concept
    - ``title`` (required): natural-language name of the mathematical object,
      like "Ramsey's Theorem"
    - ``type`` (required): a free-form label such as "theorem" or "definition"

Proof
    - none. A proof's conclusion and assumptions are its type (see Proofs);
      the spec-1 keys ``conclusion`` and ``assumptions`` do not exist in spec
      2.

The Markdown body is required for concepts and optional for proofs. A proof
docstring is parsed as markdown alone: its ``#`` sections are recorded like a
concept's, and a docstring of the proof package that carries yaml
frontmatter — on a proof or on a helper — is a violation. The whole
validity of the archive rests on the assumption that the Lean side of a
concept faithfully represents this natural-language description.

Frontmatter with an unrecognized key leads to build errors.

> draft note: the plan rules "a helper carrying docstring frontmatter is a
> violation" and "proofs carry no ``conclusion``/``assumptions`` keys", but
> does not say whether a *proof* may carry frontmatter with no keys, or with
> future keys. This draft forbids frontmatter anywhere in the proof package
> (one rule, no key set to maintain). The alternative is to parse a proof's
> frontmatter against an empty key set, which keeps the door open for later
> keys at the cost of a spec-1 ``conclusion`` key failing as "unrecognized"
> rather than as "frontmatter in a proof package".

An example concept module ``concepts/Lax261/Myconcept.lean``:

    import LaxCore
    import Mathlib.Combinatorics.SimpleGraph.Basic
    import Lax42.Colorings

    /-!
    ---
    title: Title of the concept
    type: theorem
    ---
    description of the concept
    -/

    namespace Lax261.Myconcept

    /-- an ordinary Lean docstring; no frontmatter -/
    @[lax_statement] def X : Prop := ∀ …

    /-- an auxiliary: a Prop-valued definition without the marker -/
    def IsGood (n : ℕ) : Prop := …

    end Lax261.Myconcept


An example module within the proof package:

    import Lax42.Colorings
    import Lax261.Myconcept

    namespace Lax261Proofs

    /-- description of proof Q; no frontmatter -/
    theorem Q (h : Lax42.Colorings.Somestatement) : Lax261.Myconcept.X := …

    end Lax261Proofs

## Papers

A submission may carry the paper itself: a LaTeX document declared under
``paper`` in the manifest, compiled by the archive, and shown beside cards for
the concepts, proofs, and submissions it marks. The paper only points at
content; concepts and proofs are defined by their Lean modules and
annotations as before.

Passages are marked with comment lines that the author's own build ignores:

    % lax begin Lax261.Myconcept
    ... the passage ...
    % lax end

A marker is a line whose comment text is exactly ``lax begin <id>`` or
``lax end``; any other ``% lax`` comment is a violation, so a typo cannot
silently drop a passage. Markers nest, close in the file that opened them,
and are read from every ``.tex`` file under the paper folder. ``<id>`` is a
concept id, a proof id, or a submission id (``lax-42``) of the submission
itself or of a directly required submission — to talk about it, require it.
Statement ids, package roots, and mathlib names are violations. Each marker
must survive into the PDF exactly once; a marker swallowed by a verbatim
environment or a moving argument is a violation naming its id.

The archive compiles a copy of the folder with latexmk (``-halt-on-error``,
restricted shell escape, bibtex or biber, ``SOURCE_DATE_EPOCH`` from the
source commit), with the markers rewritten into calls of the injected
``laxmark.sty`` that lower to named PDF destinations. A compile error is a
violation like a broken frontmatter; TeX warnings are not. Beside the PDF the
archive derives a reflowable web view of the same sources (ReflowTeX under
lualatex), whose text is cross-checked against the PDF's text layer before it
is recorded. The derivation never blocks: each failure is a warning on the
``paper`` phase, and the PDF stands alone.


# Archive Database

The archive stores one folder per allocated id. Every ``lax-N/`` folder
contains exactly three files: ``record.json``, ``build-output.json``, and
``owner-list.json``. They separate lifecycle and source state, validated
content, and authorization so each action changes only the files it owns.

The ``specVersion`` of these three files is the version of the **archive
schema**, not of the content spec: it stays ``"1"`` for spec-2 records, and
this spec version bumps only the content rules. A record's content spec
version is the ``specVersion`` of its manifest, found at
``inputs.manifest.specVersion`` of the build output and implied by its
environment.

Example ``record.json``

    {
      "specVersion": "1",
      "id": "lax-261",
      "state": "registered",
      "createdAt": "2026-07-01T12:00:00Z",
      "source": {
        "repository": "https://github.com/alice/mysubmission",
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "folder": "."
      }
    }

- ``record.json`` always carries ``specVersion``, ``id``, ``state``, and the
  immutable UTC ``createdAt`` timestamp. A draft carries its current
  ``source`` triple. Registration changes only the state and retains the
  source when one exists; registering an empty init record is allowed. A
  deleted record instead carries ``deletedAt`` and no source.

Example ``owner-list.json``

    {
      "specVersion": "1",
      "owners": [
        { "githubId": 583231, "handle": "alice" },
        { "githubId": 913874, "handle": "bob" }
      ]
    }

The owner list contains between 1 and 50 unique human GitHub accounts and is
sorted by numeric account id. Handles are retained for display, while numeric
ids govern authorization. Owners may be replaced while the record is init or
draft and become immutable on registration, except by maintainer action (see
Actions).

Example content-bearing ``build-output.json``

    {
      "specVersion": "1",
      "id": "lax-261",
      "issue": {
        "repositoryId": 1320232165,
        "number": 261
      },
      "inputs": {
        "manifest": { ... },
        "abstract": "..."
      },
      "requiredByConcepts": ["Lax42"],
      "requiredByProofs": ["Lax42", "Lax42Proofs"],
      "concepts": [ ... ],
      "proofs": [ ... ],
      "capture": {
        "formatVersion": 1,
        "digest": "...",
        "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
        "leanToolchain": "leanprover/lean4:v4.35.0",
        "mathlibCommit": "<the commit of mathlib's v4.35.0 tag>",
        "files": [ ... ],
        "registryBlob": "ghcr.io/lax-archive/lax-captures@sha256:..."
      },
      "certificate": { ... },
      "paper": { ... }
    }

- ``issue`` binds the database folder to its one authoritative issue by
  immutable repository id and issue number. Init and deleted records retain a
  stub ``build-output.json`` containing only ``specVersion``, ``id``, and this
  binding.
- ``inputs.manifest`` is the parsed ``manifest.yaml`` and
  ``inputs.abstract`` is its UTF-8 text with line endings normalized to LF, so
  the website needs no repository access. A ``supersedes`` claim is read from
  here; the superseded record itself is never written to.
- ``requiredByConcepts`` lists Archive packages directly required by the
  concept package, and ``requiredByProofs`` lists those directly required by
  proofs. The environment's libraries and the proof package's own concept
  path are omitted.
- ``capture`` authenticates the declared Lake and Lean package inputs,
  generated manifests, and Lake build artifacts produced by trusted
  validation. Consumers fetch its OCI blob from GHCR by the recorded digest
  and verify the archive digest and per-file hashes; mutable tags are only for
  discoverability. The environment is identified by ``leanToolchain`` and
  ``mathlibCommit``; the other library pins follow from the row.
- ``certificate`` is present in every spec-2 record (and absent from spec-1
  records): the record of the Certify phase, see below.
- ``paper`` is present iff the manifest declares a paper: the declared block,
  ``pdf`` (digest, bytes, pages, ``registryBlob``), ``pageSizes``, ``marks``
  in document order (id, kind, and the begin and end points as page, PDF
  coordinates, and TeX mode), and, when the web view was derived, ``web``
  with its ``format`` pin and ``bundle`` digest. The PDF and the web bundle
  are the second and third layers of the capture's OCI manifest, fetched and
  verified by digest like the capture itself. The web bundle's digest is a
  content address, not a reproducibility claim: re-deriving the view may
  change it.

Each entry of ``concepts``:

    {
      "id": "Lax261.Myconcept",
      "path": "concepts/Lax261/Myconcept.lean",
      "title": "...",
      "type": "theorem",
      "description": "...",
      "sections": [{ "title": "Review notes", "markdown": "..." }],
      "imports": ["Lax42.Colorings"],
      "mathlibImports": ["Mathlib.Combinatorics.SimpleGraph.Basic"],
      "sourceText": "...",
      "statements": [
        {
          "id": "Lax261.Myconcept.X",
          "levelParams": ["u"],
          "signature": "X.{u} : Prop",
          "body": "∀ (α : Type u), ..."
        }
      ]
    }

``title``, ``type``, ``description``, and optional ``sections`` come from the
concept annotation. ``imports`` lists directly imported archive modules and
``mathlibImports`` lists directly imported library modules. ``sourceText`` is
the UTF-8 file content with line endings normalized to LF. ``statements`` lists any
number of tagged definitions with their universe parameters, pretty-printed
signatures and bodies, and, where available, source ranges and docstrings;
the website marks each proven or unproven.

> draft note: the plan asks for "the pretty-printed body of every tagged
> definition for the website" without naming the field; ``body`` and
> ``levelParams`` are this draft's names. Whether ``mathlibImports`` is
> renamed now that it lists ``LaxCore`` and ``CSLib`` modules too is a
> website-compatibility question the plan does not raise; this draft keeps
> the key.

Each entry of ``proofs``:

    {
      "id": "Lax261Proofs.Q",
      "path": "proofs/Lax261Proofs/Basic.lean",
      "levelParams": ["u"],
      "telescope": {
        "hypotheses": [
          { "statement": "Lax42.Colorings.Somestatement", "levels": ["u"], "binder": "default" }
        ],
        "conclusion": { "statement": "Lax261.Myconcept.X", "levels": ["u"] }
      },
      "conclusion": "Lax261.Myconcept.X",
      "assumptions": ["Lax42.Colorings.Somestatement"],
      "description": "...",
      "sections": [{ "title": "Strategy", "markdown": "..." }]
    }

``telescope`` is the proof's type as the inspector read it: the hypotheses
in binder order, each with its statement constant, level instantiation, and
binder info, and the conclusion. ``conclusion`` and ``assumptions`` are
derived from it — the conclusion constant, and the hypothesis constants as a
sorted set without duplicates — so that readers of spec-1 records read spec-2
records unchanged. Proof entries carry no ``sourceText``: the website lists
proofs, it does not display their code.

> draft note: the plan fixes the telescope's content (ordered binders with
> constant, levels, binder info; the conclusion) and that ``conclusion`` and
> ``assumptions`` are derived; the JSON shape above is this draft's. The
> binder-info vocabulary (``default``, ``implicit``, ``instImplicit``,
> ``strictImplicit``) follows ``Lean.BinderInfo``.

The ``certificate`` block:

    {
      "judge": {
        "toolchain": "leanprover/lean4:v4.35.0",
        "comparatorExitCode": 0,
        "selfTest": { "passed": true, "probes": ["comparator-accepts", "..."] },
        "tools": { "lake": "<sha256>", "lean": "<sha256>", "leanexport": "...", "leanchecker": "...", "...": "..." }
      },
      "kernels": ["lean"],
      "bundle": {
        "formatVersion": 1,
        "digest": "<sha256>",
        "registryBlob": "ghcr.io/lax-archive/lax-captures@sha256:..."
      },
      "challengeExportSha256": "<sha256>",
      "solutionExportSha256": "<sha256>",
      "challenge": "import Lax42.Colorings\nimport Lax261.Myconcept\n\ntheorem Cert.Lax261Proofs.Q.{u} ..."
    }

No edge list is stored: the edges are the proofs' telescopes, and every
reader derives them. ``judge`` names the toolchain whose ``lake comparator``
ran, its exit code (always 0 on a record), the self-test it passed first
with every probe in order, and the sha256 of each judge binary as installed
(``lake``, ``lean``, ``leanexport``, ``leanchecker`` and the five bundled
checkers); the trusted parser refuses a certificate whose self-test did not
pass. ``kernels`` names the kernels that accepted the solution in trusted
validation (``lean`` for Lean's own kernel; ``leanchecker-paranoid``,
``lean4lean``, ``nanoda``, ``con-leche``, ``con-ron`` for the bundled
external checkers). ``bundle`` is the digest reference of the five
generated files (see Certification), fetched and verified like a capture.
``challengeExportSha256`` and ``solutionExportSha256`` are the host's
digests of the two export files the judge read, bind-mounted one at a
time: host-recorded provenance a rerun compares its own exports against.
``challenge`` is the generated ``Challenge.lean`` source verbatim: the one
artifact that states, in Lean, exactly what was certified, so the website
shows it without fetching anything; the trusted parser holds it to the
generator's regeneration from the telescopes. A record with no proofs has
no ``certificate`` key: nothing ran.

> draft note: the plan says a later run with more kernels "is the same
> command on the same bundle, published as a new attestation beside the old
> one", and that this is built when it happens. Records are immutable, so
> the home of a second attestation (a list under ``certificate``, written by
> ``revalidate``; or a file outside the record) is open; this draft records
> the one per-submit run.

The content-bearing file is deterministic: concepts, statements, proofs, and
the derived certificate edges are sorted by ``id``; package names, imports, assumptions,
capture files, and other set-like lists are sorted lexicographically.
Telescopes and annotation sections retain authorial order.


# The Archival Layer

An **owner** is a GitHub account listed in a submission's owner set, and is
thereby allowed to act on the submission (e.g., submitting and editing).
Owners act on the archival layer.

Submitted source is identified by a folder and commit hash in the authors'
public git repository. After validation, the archive also publishes an
immutable, content-addressed capture containing the exact declared Lake and
Lean package inputs, generated manifests, and artifacts that the workflow
checked.

The source repository is a canonical, anonymously fetchable HTTPS URL on
``github.com``, ``gitlab.com``, ``codeberg.org``, or ``bitbucket.org``. GitHub,
Codeberg, and Bitbucket paths contain exactly an owner/workspace and repository;
GitLab paths may include nested groups. The commit is a full lowercase
40-character SHA, and the folder is ``.`` or a relative POSIX path of at most 32
segments and 512 UTF-8 bytes without empty, ``.``, or ``..`` segments.

## Lifecycle

Submissions can be in four states within the database.

**init:** an id and owner set have been allocated for this submission, but
nothing has been uploaded yet.

**draft:** visible on the website, overwritable by its owners, not citable,
not reviewable, not usable as a dependency. A re-draft moves the record's
source triple; since the archive validates a dependent only against frozen
sources, no registered pin can go stale.

**registered:** immutable, citable, reviewable. The normal published state.

**deleted:** a permanent tombstone. The id, issue binding, owner list, and
timestamps remain, while source and validated content are removed. Deleted ids
are never reused.

The only state transitions are:

- ``-> init``
- ``init or draft -> draft``
- ``init or draft -> registered``
- ``init or draft -> deleted``

Registered and deleted records are immutable, except by maintainer action,
which is publicly logged on the submission's issue (see Actions).

## Successors

A new version of a registered submission is an ordinary new submission with a
fresh id whose manifest names the old one in ``supersedes``. Fresh ids are
essential: package names derive from the id, so both versions coexist in one
dependency graph, every dependent's pinned require stays valid, and citations
of the old id keep their meaning.

- Only a registered submission can be superseded. Drafts are updated by
  re-submitting; deleted ids are retired.
- A submission has at most one successor. The claim travels through drafts
  provisionally and binds at the successor's registration; competing drafts
  may claim the same target, and the first to register wins.
- Only the target's owners may supersede it: the account executing the
  successor's submit or register must be in the target's frozen owner list.
- The superseded record is never modified. That it is superseded is derived
  by the site generator from the successor's build output. Since a bound
  claim points at an immutable record, chains cannot form cycles.

A port across environments is such a successor and needs no rule of its own.
A submission that depends on superseded work keeps building — requires are
pinned — and is warned that a newer version exists. There is no retro-linking
and no undo: the claim lives in the immutable manifest and, once bound, is as
permanent as registration.

## Actions

Every archive action is initiated through the CLI, which creates the
authoritative GitHub issue or posts a fixed ``/lax`` command to it. GitHub
Actions validates and publishes the resulting database change.

**Init.** ``lax init`` scaffolds the complete submission layout (see CLI)
under a locally drawn id and touches nothing remote. The archive learns of
the submission on its first submit.

**Owners.** ``lax owners`` posts ``/lax owners <JSON>`` to replace the owner
list of an init or draft submission. The actor must be a current owner and
must remain in the replacement list. Numeric GitHub account ids are resolved
again before publication. On a folder that has no issue yet the command
instead stores the handles in the manifest (``initialOwners``) for the first
submit to resolve.

**Submit.** ``lax submit`` posts a (repository, commit, folder) triple. The
folder must contain a complete valid manifest whose ``id`` equals the id of
the record being submitted to. That record must be in the init or draft
state, and the authenticated GitHub account must occur in its stored owner
set.

- The first submit binds the id. The CLI checks the current Archive snapshot
  for a collision (drawing a new id and renumbering the folder if there is
  one), opens an issue in ``lax-archive/lax`` whose first line is the hidden
  marker ``<!-- lax-submission-id:lax-N -->``, and the workflow creates the
  three init stubs with the authenticated account and any ``initialOwners``
  as owners. The CLI records the issue in the manifest and stops: the author
  commits and pushes the binding, and submits again.
- A successful submit puts the submission in the draft state and replaces its
  source triple and validated content. Trusted validation rebuilds the
  immutable commit and never trusts the author's local ``build-output.json``,
  except for the presentation-only resubmission below.

- A draft may reuse its previously validated build artifacts when the control
  plane proves that the complete Git tree changed only at the submission's
  ``manifest.yaml`` or ``abstract.md`` and that the only semantic changes are
  ``title``, ``authors``, or the abstract. Both metadata files must be regular
  blobs in both commits; the repository and folder must be unchanged; the old
  files must exactly reproduce the archived inputs; both manifests must be
  valid and equal after removing ``title`` and ``authors``; and every manifest
  byte outside those two YAML value nodes must be identical. The changed-path
  set must be nonempty. Any extra path, mode or object change, any other byte or
  field change, or any failure or ambiguity while fetching, parsing, or
  comparing takes the ordinary full-validation path. On a proven match, the
  publisher reuses the content-addressed capture, updates its source-commit
  provenance to the new immutable commit, and replaces only ``record.json`` and
  ``build-output.json``.

**Register.** ``lax register`` posts ``/lax register`` and freezes an init or
draft record without rebuilding it. Every Archive dependency recorded in its
current build output must already be registered. A ``supersedes`` claim binds
here (see Successors).

**Delete.** ``lax delete`` posts ``/lax delete`` and permanently replaces an
init or draft record with a tombstone. Registration and deletion are separate,
irreversible actions and require explicit confirmation in the CLI.

**Maintainer actions.** ``/lax admin <verb> <id> [<JSON>]``, accepted only
from the numeric account ids listed in the archive's source, bypasses the
owner, open-issue, and state gates. ``revalidate`` re-runs the whole pipeline
over a draft or registered record's recorded source and republishes its
build output and captures under its current state; a ``supersedes`` claim
must come out unchanged. ``reset-draft`` returns a registered record to
draft, refused while a registered successor claims it or a registered record
builds on it; a chain is reset top-down, dependents first. ``delete``
tombstones a record in any state. ``owners`` replaces the owner list outright. Every
maintainer action is a comment on the submission's issue and an attributed
``admin`` commit to the database; the rationale lives in the comment, never
in the record.





# Implementation

- The **build pipeline** checks a submission against this spec and derives its
  ``build-output.json``. It is the sole authority on what this spec means.

- The **site generator** turns the database into the website.

- The **database repository** holds the archive's state.

- The **CLI** ``lax`` is the only thing authors and agents ever touch.

- The **GitHub Actions control plane** routes issue commands, runs trusted
  validation, publishes immutable captures and database changes, and
  dispatches the website rebuild.

## The Built Environment: A Primer

The target audience for this spec is graph theory researchers with no deep
familiarity with Lean. This section therefore sets up necessary background:
what the environment is, and why the inspector reads it instead of the source.

**The environment.** Compiling a Lean module elaborates its source: notation
is expanded, implicit arguments are filled in, tactics are run, and the
result is a set of **declarations** — constants, each with a fully qualified
name, a kind (definition, theorem, axiom, …), a type, and, except for
axioms, a value — all checked by the kernel. The environment is the map from
names to these declarations. Each module persists its declarations into its
``.olean`` file, and importing a module loads them back; imports are
transitive, so the environment the inspector sees contains every declaration of
every module beneath it — the package's own, other submissions', mathlib's,
core's. Two properties make it the right thing to inspect. First, every
declaration records its **module of origin**, and each ``.olean`` lists
exactly the constants its module contributed — so "the declarations of this
package" is a lookup, not a search through mathlib's hundred thousand
constants. Second, values are stored, so walking a declaration's type and
value transitively reaches every constant it uses — that walk
(``Lean.collectAxioms``) is how axiom sets are computed.

**Elaboration is many-to-many.** One source command can produce many
declarations, or none. A ``structure`` generates its constructor, recursor,
projections, and helper lemmas (``mk.injEq``, ``mk.sizeOf_spec``); a pattern
match compiles into auxiliary ``match_1`` functions; ``example`` produces
nothing at all. Conversely, the surface syntax is gone: the environment no
longer knows whether a definition was written as ``def``, ``abbrev``, or
``instance``. This is why every unit the archive cares about is defined as
an environment notion — a statement is a definition carrying a persisted
attribute entry, a proof is a theorem whose stored type has a certain shape,
theorem-ness is the kernel's kind, docstrings are persisted data — and why
rules that only the surface syntax could decide were dropped. The generated
declarations are harmless throughout: they are internal details (so they are
never proofs or statements), their axiom sets are empty or background, and
their names extend the parent declaration's name.

**User-level and internal names.** Lean itself distinguishes the names an
author declared from its own bookkeeping, and exposes that boundary as data.
``private`` declarations are stored under a mangled name
(``_private.<module>.0.<real name>``), and ``privateToUserName?`` inverts the
mangling exactly. Machine-generated auxiliaries carry names that
``Name.isInternalDetail`` recognizes. This is the same boundary Lean's
documentation tooling uses to list "the declarations of a module", and the
inspector adopts it wholesale rather than inventing its own. Rules that
quantify over "every name a module declares" mean user-level names in exactly
this sense.

> draft note: the plan's proof rule ("a theorem-kind declaration whose
> stored type is a chain of statement constants") does not say whether the
> enumeration ranges over user-level names only. This draft restricts
> statement-hood and proof-hood to user-level names, as the namespace and
> unused-helper checks already do, so that a generated theorem can never
> become an edge.

## Build Pipeline

The trusted pipeline fetches the submitted public Git commit from a supported
host and a pinned
Archive snapshot into an ephemeral GitHub-hosted runner. It copies that
checkout into fresh workspaces for compilation and derives all dependency
inputs from the validated lakefiles and Archive records. The local authoring
pipeline instead builds in place so ``.lake`` persists across runs.

It runs multiple phases. Violations are collected, not failed fast, so the final
report lists every violated rule. A phase with violations aborts the
subsequent phases. A report carries either a verdict on the submission or an
operational failure — an Archive resource limit, an infrastructure fault —
never both; hitting a resource limit is not a rejection on content. Finding
text is normalized to the report schema: line breaks appear as `` ⏎ `` and
over-long text is elided with `` […] ``.

- **Static validation** (milliseconds): folder layout, file limits, license,
  ``abstract.md``, manifest schema, ``lean-toolchain``, the lakefile whitelist
  and libraries rule of the Packages section, and that no generated file is
  tracked by Git. The
  submission must be inside a Git repository; inability to inspect its tracked
  tree is a violation. This phase also derives each package's **module
  inventory**: the root module plus one module per ``.lean`` file under
  the package's module folder, read off the file paths via Lake's
  canonical mapping (``Lax261/Foo/Bar.lean`` is ``Lax261.Foo.Bar``). The
  inventory is the pipeline's only answer to which modules a package
  contains: Replay's root target and Inspect's import list are taken from
  it, never from build artifacts, which Compile — untrusted code — wrote.
  The import rule and root-module exactness are not checked here: imports
  are taken from the built environment and judged at Inspect, so the
  pipeline never parses source.

- **Resolution** (milliseconds): check every direct and transitive Archive
  dependency against one exact database snapshot. Each direct git require
  must match a registered record's canonical source triple, every
  dependency must be in the submission's environment and provide a capture
  built against its pins, and a ``supersedes`` claim must name a registered
  record with an overlapping owner list and a free successor slot. A require
  on a draft record is a violation whose message names the fix: register the
  dependency first. Only ``lax build --nonstrict`` admits it, with a warning
  (see CLI). A superseded dependency, direct or
  transitive, is a warning naming its successor. A local miss may mean the
  checkout at ``~/.lax/lax-database`` is stale, so the finding suggests
  ``lax sync`` and a retry.

- **Provision:** ensure the environment's **warm workspace** — the
  environment's libraries, built — exists and
  generate each package's complete ``lake-manifest.json`` and
  ``.lake/package-overrides.json``. In trusted validation, dependency captures
  are downloaded from GHCR by digest, verified, extracted read-only, and
  mounted with the VM-installed toolchain and warm workspace into fresh build
  workspaces. Local builds instead use exact git dependencies in the generated
  manifests and build them from source inside the package workspace. A
  nonstrict build also lists its siblings (see CLI) as path entries. The
  generated manifest is flat: lake does not read a path dependency's own
  manifest, so every transitive require, git or path, appears in the
  requiring package's manifest. ``lax init`` performs the same local seeding
  for a fresh scaffold.

- **Compile:** run ``lake build`` for concepts first and proofs second. Trusted
  validation runs each package in a fresh, networkless, hardened container;
  the repository mount is read-only and only its isolated ``.lake`` build
  directories are writable. Local builds run through the pinned host
  toolchain in the submission's own packages and stream their transcript.
  When concepts fail, proofs are skipped.

- **Replay:** re-check every declaration of the concept package with
  ``leanchecker`` from the pinned toolchain. The pipeline invokes it directly
  over a search path composed from the just-captured submission artifacts,
  verified dependency captures, and the warm workspace; it never uses
  ``lake env`` or dependency artifacts written during Compile. Trusted
  validation always replays the concept package. Local authoring skips
  Replay by default and enables it with ``lax build --replay``. The proof
  package is not replayed in spec 2: its edges are established by Certify
  alone, and no archive standard reads anything Replay would add (see "The
  three questions" below). Concept packages are replayed because every later
  record imports them and the archive presents them as the statement
  surface a reader trusts.

  The guarantee this leaves is narrower than "the package was checked", and
  the archive says so: the certified edges are kernel-checked by the judge
  over their whole cones; every other declaration of a proof package — a
  helper no edge reaches, a package with no classified edges — is not
  independently replayed. A proof package another record requires is
  imported as ordinary Lean content, and its non-edge declarations carry no
  archive guarantee; a downstream record's own certified edges are judged
  afresh, cones included, so nothing unchecked reaches an edge the archive
  vouches for. A consumer who needs checked reusable helpers runs
  ``lax build --replay`` over the package: the local flag replays both
  packages, which is exactly the check the archive's own run omits.

- **Inspect:** extract environment facts with the ``Lax.Inspector``
  executable, then judge every remaining rule in the TypeScript pipeline —
  including the import rule, root-module exactness, statement-hood, and
  proof-hood — see below.

- **Certify** (spec-2 environments only): prove the judge on lax's own
  one-line modules, then generate the **certificate bundle** from the
  inspected telescopes and have the environment's own ``lake comparator``
  judge it — a build and an export container per side, then a clean judge
  over the two read-only exports — see Certification below. The
  comparator's own rejection diagnostics are violations reported per edge;
  a record with no proofs runs nothing.

- **Paper** (only for a declared paper, concurrently with Compile through
  Certify): the marker gate, the PDF compile, and the web derivation of the
  Papers section. Marker ids resolve against the inspected concepts and
  proofs and the records of the directly required packages. Trusted
  validation runs both compiles in the TeX Live image; a local build uses the
  host ``latexmk`` for the PDF and skips the paper with a note when there is
  none.

- **Emit:** after a successful full build, derive deterministic
  ``build-output.json``, a capture manifest, and, in spec 2, the certificate
  bundle's manifest. The local CLI writes the file
  atomically into the submission root, and ``paper.pdf`` beside it; trusted
  validation instead uploads the generated payload, the sealed
  ``capture.tar``, and the bundle for credential-free publication preflight.
  Partial builds emit neither.

**The three questions.** Trusted validation answers three questions, each
by one piece of the pipeline, and no piece answers another's; a fourth
piece binds the three answers to the record.

*Correctness of the Lean theorem* is the judge's: Certify's containers
and the comparator — the toolchain's own tool, frozen with the
environment. A Challenge that imports only concept packages states each
edge as a theorem, a Solution that imports the proof package discharges it
by applying the proof, and the comparator checks that both state the same
theorem, that the solution's axiom closure is the background three, and
that the kernel accepts it, over an export of the Solution's whole cone.
This is the sole proof-validity check for a certified edge; nothing else in
the pipeline contributes to it, and nothing else may claim to. Before it
judges anything of the record, the judge proves itself: the same containers
build, export and judge three one-line modules lax owns — a matching pair
the comparator must accept, a mismatched pair it must reject, and a Solution
export whose proof term was replaced by its statement, which the kernel must
refuse — and probe the judge's confinement from inside (a canary the host
wrote is invisible, there is no network interface, ``which leanchecker`` is
the toolchain's, nothing but ``/out`` is writable). The host digests the
judge's binaries before the first container and holds them to the same
digests after the judge has run. A wrong answer anywhere is an
infrastructure failure, never a finding against the author; the record
carries the probes that passed and the digests beside the toolchain name.
A reader who reruns the bundle trusts the toolchain and its kernels, the
environment's libraries (mathlib, ``LaxCore``, ``CSLib`` where required),
and the concept packages the record depends on — "concept packages you
depend on are trusted, as today" — and, for the rerun itself, nothing of
lax.

*The theorem is the edge* is the translation's: the TypeScript that turns
the inspector's telescope reading into Challenge and Solution. It checks
that every constant names a registered statement of a package the record
requires, that the universe rule holds, and that the edge list the record
carries is exactly what is rendered. This is correctness-critical: the
judge verifies whatever Challenge it is handed, so a ``C.{u,u}`` conclusion
passed through would be judged correctly and recorded wrongly. The record
stores ``Challenge.lean`` verbatim and the website shows it beside the
record, so a reader audits the translation by reading a few lines of Lean
and checking that each theorem states the edge they care about. That audit
covers the visible implication and its universes; what the imported
constants mean, and whether the published verdict belongs to those bytes,
is the fourth piece's.

*Provenance and binding* is everything that connects the three answers to
the published record: the captures the Challenge was built against and
their digests, the environment's pins, the warm workspace, the host-recorded
digests of both exports, the publisher's credential-free regeneration of
the five bundle files from the record's own data, and the database commit.
The judge establishes a property of two export files under a
configuration; that the Challenge export is the published Challenge built
against the concept definitions the record identifies, that the library
artifacts are the recorded pins, and that the verdict is attributed to this
record, rests here. This is where the trust in concept authors lives, the
submission's own concept package included: a reader who wants more than
the Challenge checks the Solution's application of the named proof,
``comparator.json``'s target list and permitted axioms, the statement
definitions in the concept source, the lakefile pins and the toolchain, and
the export digests — all of which the record and its bundle carry. The
defensible sentence is: the judge is the sole proof-validity checker for
certified edges; archive edge soundness additionally requires faithful
translation, authentic Challenge inputs, and correct binding of the verdict
to the published record.

*Conformity with archive standards* is the inspector's and its TypeScript
rules': what the archive requires because it wants its records a certain
way, enforced whether or not correctness needs it — the namespace rule
(composition), the whole-package axiom-free and ``sorry``-free rule, the
frontmatter rules, the import rule, root-module exactness, the unused-lemma
warning, docstrings. Every such finding is a rejection, labelled as a
standard. Inspect reads what Compile's oleans say; Compile is where
untrusted code runs, so these are the author's claims about their own
package plus facts a faithful reader takes from the olean (names, kinds,
bodies), and the inspector loads no extension and runs no initializer of
the submission. Anything a forged olean could claim here that reaches an
edge's cone is re-checked by the judge; what does not reach one is a lie
about the author's own record's style. Every cross-package claim —
including which constants of a required package are its statements — is
checked against the database, never the workspace (see Inspection
Internals). Layout, lakefiles, and the manifest are read from the files
directly.

Every finding carries which question it answers (``judge``,
``translation``, ``standards``), and ``lax submit`` and ``lax build`` print
the three apart: the proof does not establish the edge; the theorem is not
the edge the record claims; an archive standard, not a correctness failure.

The chain bottoms out in Lean's kernel, the environment's
toolchain and library revisions, digest-addressed dependency captures, and
the protected publication workflow.

Author-code execution and artifact processing use isolated containers from a
stock image pinned by digest. Each container is read-only and capability-free,
inherits only explicit mounts and environment values, and is limited to 16
GiB memory, four CPUs, 1,024 processes, bounded output and workspace size, and
phase timeouts. Replay and Inspect use two Lean workers. The paper's PDF
compile has ten minutes and the web derivation thirty; exceeding the latter
skips the web view rather than failing the submission. Certify runs in the
same runner under the same mounts and limits.

> draft note: the plan gives Certify no timeout of its own. The spike
> measured ~10 s per two-edge bundle warm and 2–66 s per kernel for mathlib
> cones of 3k–30k declarations; the Lax17 port (stage 6) is to measure the
> real cone cost. A per-phase timeout is a limits-table value once measured.


### Inspection Scaffolding

All archive-side meta-programming lives in ``Lax.Inspector``, a Lean
package providing one executable: built with the environment's toolchain,
importing only Lean core, never mathlib and never ``LaxCore``. (Replay needs
no counterpart — ``leanchecker`` ships inside the toolchain itself; nor does
Certify — ``lake comparator`` does too.) The inspector's source
ships with the CLI; the first ``lax build`` on a machine compiles it into
``~/.lax/tools/<cli-version>-<hash>/``, keyed by source and toolchain, and
every later run in that environment reuses it. Trusted runner setup builds
the same inspector before submission code runs. One inspector source serves
both spec versions; the invocation passes the spec version, and the spec-1
report stays byte-identical.

The inspector is an executable, never an elaborated command: it loads the
package's oleans directly and executes no code from outside its own binary
and Lean core. Importing a module must not run its ``initialize`` blocks,
and nothing imported may be evaluated, because once untrusted code runs in
the inspecting process, nothing that process writes is authentic. What
remains is enough: docstrings, module docs, constant lists, and attribute
entries are persisted data, axiom walks and type walks are pure traversals,
and defeq is kernel reduction. In particular the ``lax_statement`` attribute
is read **as data**, not by importing ``LaxCore``: a tag attribute persists
its tagged names as the exported entries of its environment extension, and
the inspector looks those entries up by the extension's name in each
module's persisted entry table. ``LaxCore``'s ``initialize`` never runs in
the inspector.

The inspector computes exactly the facts the validator cannot — everything
that needs the loaded environment or the kernel — and the validator, which
alone holds the archive context (the verified ``[[require]]`` set, the
manifest, the database, the environment row), judges every rule. The
inspector decides nothing about validity: a tagged definition with binders
or a malformed frontmatter appears in the report as a fact and becomes a
violation only in the validator.

Frontmatter is parsed by the inspector, not the validator, so that
inspection is single-pass, the report carries structured annotations rather
than raw docstrings, and the frontmatter grammar (see Annotations) is
implemented once. (In spec 1 it was also where the proof's ``conclusion``
was read; in spec 2 no kernel fact is indexed by a docstring, and the
inspector reports a frontmatter in the proof package as a fact for the
validator to reject.)

Inspection runs once per package: the executable is invoked with the
package's module inventory (see Static validation), the spec version, and
an output path as
its arguments, under the same pipeline-composed search path as Replay —
never ``lake env``. The executable imports the inventory's modules with
initializer execution disabled, inspects the resulting environment, and
writes one JSON report to the output path. Importing the inventory rather
than the root module anchors coverage to the file tree: a module the root
fails to import is still inspected — and convicts the root — instead of
silently dropping out of the environment. Statement
signatures and bodies are pretty-printed with core notation only:
delaborators and
unexpanders are imported code, and running mathlib's would mean running the
submission's too. The report
contains:

- per module of the package: its direct imports as recorded in the
  environment header — this is where all import data in the pipeline comes
  from — and its module docstrings, frontmatter-parsed into annotations
  (parse problems are reported as facts like everything else);

- per declaration whose module of origin lies in the package: name, kind,
  module of origin, axiom set, the package's own constants it refers to
  directly, whether the name is user-level (internal details flagged,
  private names un-mangled), its docstring parsed the same way, and four
  spec-2 facts: ``laxStatement`` (whether the ``lax_statement`` entry names
  it), ``isProp`` (whether its stored type, metadata stripped, is raw
  ``Sort 0``), ``levelParams`` (its universe parameters), and ``telescope``
  — when the stored type is a chain of ``∀``-binders over constants ending
  in a constant, the ordered binders, each with the constant's name, its
  level instantiation, and its binder info, and the conclusion constant with
  its levels; otherwise ``null``. The telescope is a syntactic walk of the
  stored type with no reduction and no judgment: whether its constants are
  statements is the validator's question;

- the pretty-printed signatures and bodies of the package's tagged
  definitions.

The report is a pure function of the workspace's oleans, the module
inventory, the spec version, and the inspector version: the inventory comes
from the file tree, and no archive context flows into the invocation, so the
same built workspace always yields the same report.

### Inspection Internals

The primer supplies every notion the pipeline needs; this subsection spells
out how each check reduces to a validator-side judgment over the reported facts.

**One enumeration.** The inspector considers exactly the declarations whose
module of origin lies in the package under inspection, taken from the
modules' own constant lists. This includes everything elaboration generated
on the package's behalf — helper lemmas, matchers, even lemmas Lean realizes
on demand for *imported* constants (equation lemmas of a mathlib definition,
say), should Lean attribute those to the realizing package. Nothing is
exempted: generated declarations satisfy every rule on their own, as the
primer explains, so uniform treatment costs nothing.

**Axiom checks are set comparisons.** The spec phrases its rules in terms of
``#print axioms`` because that is the familiar name; the inspector calls the
API behind the command (``Lean.collectAxioms``, the walk from the primer)
and reports the resulting set per declaration. Every axiom rule is then, in
the validator, one comparison against an allowed set — and in spec 2 the
allowed set is the same in both runs: the three background axioms, nothing
else. The spec-1 branch that admitted "statements of required concept
packages" in the proof run is gone, because a statement is no longer an
axiom and cannot appear in the set. Anything outside the background set is a
violation — a ``sorry``, an unexpected axiom arriving through a library, a
native-computation axiom. A declaration of axiom *kind* is a violation on
its own, before any set is compared.

**Statement-hood.** A declaration is a statement iff it is user-level, of
definition kind, ``laxStatement``, ``isProp``, not private, and lies in the
concept package. ``isProp`` already excludes binders: a stored type that is
a ``∀`` is not the sort ``Sort 0``, so a parameterised definition fails this
conjunct, and the finding names the binders when the type's outermost node
is a ``∀`` ending in ``Sort 0``. Each failing conjunct on a
tagged declaration is one violation naming the rule — kind, type, binders,
private, package. The attribute's own hook is never consulted; a workspace
whose oleans carry a tag the hook would have refused is judged exactly like
one whose author wrote the attribute by hand. A ``laxStatement`` entry in
the proof run is a violation.

**Proof-hood.** A declaration of the proof package is a proof iff it is
user-level, of theorem kind, not private, and its ``telescope`` is non-null
with every constant — each hypothesis and the conclusion — a statement of a
required concept package or of the package's own concept package. A
constant of the proof package's own concept package is a statement iff that
package's inspection (the concept run of the same build) classified it as
one. A constant of a required package counts iff its module of origin lies
in that package — a prefix test of the module name against the package
names whose ``[[require]]`` entries Resolution has just verified — **and**
its name appears among the ``statements`` of that submission's
``build-output.json``: the database, not the workspace, is the authority on
another submission's statements, so a forged module under a required
package's name classifies as nothing. A forgery that keeps the names and
changes the bodies beneath them is excluded because the upstream oleans are
provisioned from their verified captures (see GitHub Actions), and the
certificate's Challenge is built from those same captures. A theorem with a
telescope whose constants are all statements but one of which lies in a
package only transitively reachable is a violation (see Proofs, "Required
packages only"); a theorem whose telescope is null, or contains a constant
that is no statement anywhere, is a helper. The universe rule is a check
over the telescope's level instantiations against ``levelParams``: every
level is a parameter of the proof, and the conclusion's are pairwise
distinct. A private theorem with a statement telescope is a violation.
Every proof's telescope is copied into ``build-output.json``, and the edge
``{S₁ … Sₖ} → C`` is read off it.

**Frontmatter in the proof package.** The inspector reports, per
declaration, whether its docstring opened yaml frontmatter. In the proof run
any such declaration — proof or helper — is a violation naming the spec-1
habit.

**The namespace check.** Restrict the enumeration to user-level names — drop
the internal details, un-mangle the private names; the boundary from the
primer — and the check is a single prefix test: the module name for
concepts, the package name for proofs. Generated declarations pass because
their names extend their parent's; realized lemmas for imported constants
are internal details and drop out before the test; a declaration escaping
via ``_root_.`` fails, which is the point of the rule.

**The import rule and the root module.** The reported per-module imports
replace any reading of import lines from source. The import rule is a
prefix test in the validator: an import's first component identifies its package
(the fixed-names rule), and the allowed set follows from the verified
``[[require]]`` entries and the environment's library table. Root-module
exactness is three facts from the same
report: the root module imports exactly the other modules of the inventory
(tolerating the implicit ``Init`` of an empty package), contributes no
declarations, and carries no module docstring. No separate file-tree
cross-check is needed: the inventory *is* the file tree, and Replay and
Inspect enumerate exactly it — a source file the root fails to pull in is
still inspected (and, in the concept package, replayed), and a root import
naming a module outside the inventory fails exactness directly.

**Unused helpers.** The reported constant references form a graph over the
package. The validator walks it from the proofs; a user-level
theorem-kind declaration it does not reach is an unused helper. Generated and
internal declarations are excluded, and ``lemma`` and ``theorem`` are alike
because both are theorem kind to the kernel.

**The pipeline never parses Lean.** Every unit the report contains is
environment data: a concept is a module, a statement is a definition
(``ConstantInfo.defnInfo``) from a concept module named by the persisted
``lax_statement`` entries, a proof is a theorem whose stored type walks as
a chain of constants, theorem-ness is the kernel's kind, imports are the
environment header's module data, and the annotations are persisted
docstrings (``getModuleDoc?`` for modules, ``findDocString?`` for
declarations). No component of the pipeline reads source as Lean at all;
Emit copies files into ``sourceText`` with line endings normalized to LF,
which is a copy, not a parse. The one place the pipeline *writes* Lean is
the certificate generator, and it writes only names it escaped from
``Lean.Name`` values the inspector reported, never text it interpolated from
a string (see Certification).

### Certification

Certify is the fourth content phase, after Compile, Replay (concepts only),
and Inspect, in spec-2 environments. It runs in the existing docker runner with the existing
mounts and limits, and it adds nothing to what the archive *decides* — the
validator has already classified every proof — but a great deal to what a
reader can *check*: the certificate is a ``(Challenge, Solution)`` pair for
the toolchain's ``lake comparator``, which anyone can rerun with nothing of
lax installed.

**The bundle.** From the record's telescopes and canonical names, lax
generates five files. Every name is written from the archive's canonical
form, quoted with ``«…»`` where Lean needs it and never interpolated from
a reported string; a name whose components do not round-trip through the
canonical form is refused before anything is generated (see Namespaces).

1. ``lakefile.toml``: the environment's libraries at the row's pins, and
   every concept and proof package involved — the required ones at their
   records' source triples, the submission's own at its own source triple —
   as git requires; two ``lean_lib`` targets, ``Challenge`` and
   ``Solution``. The runner satisfies the git requires from the verified
   captures through package overrides, exactly as Provision does for the
   build, so the container stays networkless; a reader elsewhere lets lake
   fetch them.
2. ``lake-manifest.json``: the resolved closure, because the sandboxed
   comparator refuses a project without one.
3. ``Challenge.lean``: imports the concept modules the edges mention and
   nothing of any proof package; per proof, one theorem

       theorem Cert.<proof-id>.{<the proof's level parameters>}
         (h₁ : S₁) … (hₖ : Sₖ) : C := sorry

   with the hypotheses in the proof's own binder order and binder kinds
   (explicit, implicit, instance, strict implicit — the Solution applies
   the proof with ``@``, so the kinds are preserved rather than
   normalized), and every statement constant instantiated exactly as in
   the proof's type. The theorem name is ``Cert`` prefixed to the proof's
   canonical name.
4. ``Solution.lean``: imports the proof modules; the same theorems, each
   discharged by ``@<proof-id>.{<levels>} h₁ … hₖ`` — the proof applied with
   ``@`` so binder info is irrelevant.
5. ``comparator.json``: ``challenge_module: "Challenge"``,
   ``solution_module: "Solution"``, ``theorem_names`` — the ``Cert`` names
   in the record's edge order — ``definition_names: []`` always, and
   ``permitted_axioms`` — the three background axioms.

A record with no proofs has no bundle and no ``certificate`` block:
nothing runs.

**Five containers, after the self-test.** The judge self-test runs first
(see "The three questions"): the same container shapes over three one-line
modules lax owns, then the confinement probe; the host has digested the
judge's binaries before it. Then:

- **A1** mounts the warm workspace, the record's own concept capture and
  the concept closure's captures read-only, and the Challenge half of the
  generated project with a writable ``.lake`` and nothing else writable;
  it runs ``lake build Challenge``. This is where concept-package code
  runs — every module initializer of the closure. Nothing of any proof
  package is mounted.
- **A2** is a fresh container over A1's build tree mounted **read-only**,
  with ``/out`` as its only writable mount; it runs the toolchain's
  ``leanexport`` to ``challenge.export`` and then the inspector over the
  built Challenge, both of which import with extensions disabled, so no
  record code runs and no process of A1 is alive. The host holds every
  ``Cert.<proof-id>`` theorem the inspector read — statement constants,
  universe instances, binder positions and kinds, level parameters — to
  the recorded telescope; a disagreement is a ``translation`` violation.
  Each export is thus a verifier-owned file no candidate phase can write
  to.
- **B1** mounts what A1 had plus the proof capture and the whole project
  and runs ``lake build Solution``: the only container that executes the
  proof package's code.
- **B2** exports the Solution over B1's read-only build tree, as A2 does.
- **C**, the judge, is a fresh container with the bundle's five files
  read-only, both exports bind-mounted read-only as single files, the
  toolchain, the tools, and a read-only ``git`` shim — no capture, no warm
  workspace, nothing writable but ``/out`` — running

      lake comparator --challenge-from-export … --solution-from-export … --inadvisably-no-sandbox [--paranoid]

  with the kernel set the environment names (Lean's own kernel alone for
  ``v4.35.0`` at admission). With both exports supplied the comparator
  builds and resolves nothing; it parses the two exports, compares the
  theorems, and runs the kernels over the Solution export. The host
  records the sha256 of both exports as it bind-mounted them.

The comparator's own sandbox is bubblewrap, which the docker sandbox does
not admit; the container layout supplies what that sandbox is for. Nothing
a build writes reaches its export step except the build tree, read-only;
nothing B1 or B2 writes reaches C; C's PATH has no writable entry, which is
what makes ``which leanchecker`` resolve to the toolchain's. After C the
host digests the judge's binaries again and refuses the certificate if any
changed.

**Verdict.** Exit 0 is the verdict. Exit 1 with one of the comparator's
own diagnostics is a violation reported per edge, labelled ``judge`` — the
theorem whose statement differs between the two exports, the illegal
axiom, or a kernel's rejection, which the comparator reports only for the
kernel's own exit 1. A Solution that does not elaborate in B1 is the
judge's no one step early (``solution-build``); a Challenge that does not
build in A1 is a ``translation`` finding, since no proof code is present
there — its cause is lax's generator or, under decision 8's trust in
concept authors, the concept package's own build. Everything else — the
comparator's exit 2, a kernel that crashed or was killed, a tool that did
not start, a signal, a container that hit its limit, a kernel disagreeing
with Lean's under ``--paranoid`` — is an infrastructure failure for the
archive to examine, never a finding against the author. A violation's
message asks the author to report it as a lax bug only if their package
builds cleanly with ``lax build``.

**Publication.** The five files are pushed to the capture store as one
digest-addressed bundle before the database commit that references it, and
``build-output.json`` records the bundle digest, the judge (toolchain,
self-test, tool digests), the kernels that ran, both export digests, and
the ``Challenge.lean`` source verbatim (see Archive Database). The publisher
regenerates the five files from the record's own stored data, re-seals
them, and holds the published tar to them byte for byte, credential-free,
before any token is minted. Rerunning a published bundle is ``lax certify
lax-N --run``, or by hand: fetch the five files by digest, ``lake
comparator`` in the folder (with its own sandbox, and ``--paranoid`` if
desired). ``lax certify --run`` verifies every checkout in its workspace at
the bundle's pinned revision and clean before it runs, and removes the
record packages' build products, so a previous run's proof build cannot
feed the next run's Challenge.

> draft note (2026-10-04, open for Jan): three binding questions the
> reviews raised are not settled here. (1) *Revalidation*: ``/lax admin
> revalidate`` of a concept record replaces its capture while dependents
> keep certificates judged against the old one; a statement whose body
> changed (compile-time code with a date threshold passes concept Replay)
> would then show as proven. Options: refuse a revalidation whose concept
> capture digest changes while registered dependents exist, or make it a
> new version under supersedes; in every case record the dependency
> capture digests in the certificate and resolve a certified edge's
> endpoints by (statement id, capture digest). (2) *Metadata-only
> resubmission* moves ``record.source`` to the new commit while the
> certificate bundle's own-package require still names the certified one,
> so ``lax certify`` regenerates a different digest than ``--fetch``
> returns; record the certified source commit beside the presentation
> source, or regenerate the bundle on that path. (3) The website's trust
> note should say what the Challenge and the bundle establish and what a
> reader must check beyond them (the fourth piece), not that the reader
> need not trust the pipeline.

> draft note: the plan places the bundle in the capture store; whether it
> is a further layer of the record's capture OCI manifest (as the paper PDF
> and web bundle are) or a blob of its own is not said. This draft assumes a
> further layer, which the existing fetch-and-verify path already handles.

**What a verifier trusts.** A reader who reruns a bundle and sees exit 0
trusts: the Lean toolchain of the environment and the kernels that ran; the
environment's libraries at their pins (mathlib, ``LaxCore``, and ``CSLib``
where the Challenge imports it); and the concept packages the record
depends on, fetched at their recorded commits — their statements mean what
their descriptions say, and their modules do what concept modules do.
Concept packages you depend on are trusted, as today; the concept dialect,
if it ever lands, tightens this without changing a data shape. For the
rerun itself the reader trusts nothing of lax. The Challenge is the
complete statement of what was certified and the website shows it beside
the mark; a reader who wants to tie that statement to the published
verdict also reads the Solution, ``comparator.json``, the statement
definitions in the concept source, the lakefile pins, and the export
digests the record carries (see "The three questions", provenance and
binding).

**Local builds.** ``lax build`` runs Certify as well, through the host
toolchain's ``lake comparator``. A local run proves no runner: its
certificate records ``selfTest: { passed: false, probes: [] }`` and the
host toolchain's own tool digests, and the trusted parser never admits it.

> draft note: the plan says "local ``lax build`` runs the same phase
> through the same runner", and the runner is the docker runner — but
> "Docker is required only by trusted validation, not by CLI authoring"
> (Distribution). Options: the host comparator with its own bubblewrap
> sandbox where the machine allows it (the spike needed an AppArmor profile
> no package ships), ``--inadvisably-no-sandbox`` otherwise, with the build
> output noting which; or Certify skipped locally by default and enabled
> with a flag, as Replay is; or docker when present. This draft takes the
> first; the plan should say.

**Relative certificates.** For any derivation the proof network admits —
a statement proven, or proven relative to a set of statements — ``lax
certify`` composes a standalone certificate: the Challenge states the
implied edge as one theorem (the relative-to statements as hypotheses, the
target as conclusion), and the Solution discharges it by applying the
proofs along the witness forest that ``lax generate-prooftree``'s selection
already computes, innermost first, each proof's hypotheses filled by the
theorems proving them or by the hypotheses of the certificate. The
composition is name-only and sound by the universe rule; the comparator's
rejection of an ill-typed composition is the test that the rule is right.

**A worked example.** Two submissions. ``lax-42`` declares a statement and
proves it unconditionally; ``lax-261`` requires ``lax-42``'s concepts,
declares a statement of its own, and proves it from ``lax-42``'s.

``lax-42``, ``concepts/Lax42/Primes.lean``:

    import LaxCore
    import Mathlib.Data.Nat.Prime.Defs

    /-!
    ---
    title: Prime divisors
    type: theorem
    ---
    Every natural number above one has a prime divisor.
    -/

    namespace Lax42.Primes

    @[lax_statement] def ExistsPrimeDivisor : Prop :=
      ∀ n : ℕ, 1 < n → ∃ p, Nat.Prime p ∧ p ∣ n

    end Lax42.Primes

``lax-42``, ``proofs/Lax42Proofs/Primes.lean``:

    import Lax42.Primes
    import Mathlib.Data.Nat.Prime.Basic

    namespace Lax42Proofs

    /-- Mathlib's `Nat.exists_prime_and_dvd`, specialised. -/
    theorem existsPrimeDivisor : Lax42.Primes.ExistsPrimeDivisor :=
      fun n hn => Nat.exists_prime_and_dvd (by omega)

    end Lax42Proofs

This is the edge ``{} → Lax42.Primes.ExistsPrimeDivisor``. After ``lax-42``
is registered at commit ``0123…4567`` of ``https://github.com/alice/primes``,
``lax-261`` requires ``Lax42`` (concepts) in its concept package and in its
proof package.

``lax-261``, ``concepts/Lax261/Infinite.lean``:

    import LaxCore
    import Mathlib.Data.Nat.Prime.Defs

    /-!
    ---
    title: Infinitude of primes
    type: theorem
    ---
    There are infinitely many primes: above every natural number lies a prime.
    -/

    namespace Lax261.Infinite

    @[lax_statement] def InfinitelyManyPrimes : Prop :=
      ∀ n : ℕ, ∃ p, Nat.Prime p ∧ n < p

    end Lax261.Infinite

``lax-261``, ``proofs/Lax261Proofs/Euclid.lean``:

    import Lax42.Primes
    import Lax261.Infinite
    import Mathlib.Data.Nat.Factorial.Basic

    namespace Lax261Proofs

    theorem one_lt_factorial_succ (n : ℕ) : 1 < n.factorial + 1 := by
      have := Nat.factorial_pos n
      omega

    theorem prime_dvd_factorial_succ_gt {n p : ℕ} (hp : Nat.Prime p)
        (hd : p ∣ n.factorial + 1) : n < p := by
      by_contra hle
      push Not at hle
      have h1 : p ∣ n.factorial := Nat.dvd_factorial hp.pos hle
      have h2 : p ∣ 1 := (Nat.dvd_add_right h1).mp hd
      exact hp.one_lt.ne' (Nat.dvd_one.mp h2)

    /-- Euclid's argument, assuming that every `n > 1` has a prime divisor. -/
    theorem euclid (h : Lax42.Primes.ExistsPrimeDivisor) :
        Lax261.Infinite.InfinitelyManyPrimes := fun n => by
      obtain ⟨p, hp, hd⟩ := h (n.factorial + 1) (one_lt_factorial_succ n)
      exact ⟨p, hp, prime_dvd_factorial_succ_gt hp hd⟩

    end Lax261Proofs

``euclid`` is a proof: theorem kind, stored type ``∀ (h :
Lax42.Primes.ExistsPrimeDivisor), Lax261.Infinite.InfinitelyManyPrimes``, a
chain of two statement constants of required packages, no universe
parameters. Its edge is ``{Lax42.Primes.ExistsPrimeDivisor} →
Lax261.Infinite.InfinitelyManyPrimes``; the two helpers above it are
helpers. Inspect records its telescope; the website shows
``InfinitelyManyPrimes`` as proven, because ``ExistsPrimeDivisor`` is.

The bundle Certify generates for ``lax-261`` (the submission at commit
``89ab…cdef`` of ``https://github.com/alice/infinite``):

``lakefile.toml``:

    name = "LaxCertificate"
    defaultTargets = ["Challenge", "Solution"]

    [[require]]
    name = "mathlib"
    git = "https://github.com/leanprover-community/mathlib4"
    rev = "<the commit of mathlib's v4.35.0 tag>"

    [[require]]
    name = "LaxCore"
    git = "https://github.com/lax-archive/lax-core"
    rev = "<the LaxCore commit of the v4.35.0 row>"

    [[require]]
    name = "Lax42"
    git = "https://github.com/alice/primes"
    rev = "0123456789abcdef0123456789abcdef01234567"
    subDir = "concepts"

    [[require]]
    name = "Lax261"
    git = "https://github.com/alice/infinite"
    rev = "89abcdef89abcdef89abcdef89abcdef89abcdef"
    subDir = "concepts"

    [[require]]
    name = "Lax261Proofs"
    git = "https://github.com/alice/infinite"
    rev = "89abcdef89abcdef89abcdef89abcdef89abcdef"
    subDir = "proofs"

    [[lean_lib]]
    name = "Challenge"

    [[lean_lib]]
    name = "Solution"

``Challenge.lean``:

    import Lax42.Primes
    import Lax261.Infinite

    theorem Cert.Lax261Proofs.euclid (h₁ : Lax42.Primes.ExistsPrimeDivisor) :
        Lax261.Infinite.InfinitelyManyPrimes := sorry

``Solution.lean``:

    import Lax261Proofs.Euclid

    theorem Cert.Lax261Proofs.euclid (h₁ : Lax42.Primes.ExistsPrimeDivisor) :
        Lax261.Infinite.InfinitelyManyPrimes := @Lax261Proofs.euclid h₁

``comparator.json``:

    {
      "challenge_module": "Challenge",
      "solution_module": "Solution",
      "theorem_names": ["Cert.Lax261Proofs.euclid"],
      "definition_names": [],
      "permitted_axioms": ["propext", "Quot.sound", "Classical.choice"]
    }

plus the generated ``lake-manifest.json``. Container A builds and exports
``Challenge`` with ``Lax42``'s and ``Lax261``'s concept captures mounted;
container B runs the comparator with ``Lax261Proofs``'s capture mounted and
``challenge.export`` read-only; exit 0; the bundle is pushed; the record's
``certificate`` lists the one edge, the digest, ``kernels: ["lean"]``, and
the Challenge source above.

The relative certificate ``lax certify Lax261.Infinite.InfinitelyManyPrimes``
— the statement proven outright, through ``lax-42``'s proof — differs only
in the Solution:

    import Lax42Proofs.Primes
    import Lax261Proofs.Euclid

    theorem Cert.Lax261.Infinite.InfinitelyManyPrimes :
        Lax261.Infinite.InfinitelyManyPrimes :=
      @Lax261Proofs.euclid (@Lax42Proofs.existsPrimeDivisor)

with ``Lax42Proofs`` added to the lakefile, the Challenge stating the
unconditional theorem, and ``theorem_names`` naming it. ``lax certify
Lax261.Infinite.InfinitelyManyPrimes --relative-to
Lax42.Primes.ExistsPrimeDivisor`` is instead the per-submit certificate's
single edge again, under the relative theorem's name.

> draft note: the certificate theorem of a relative certificate is named
> here ``Cert.<statement-id>``; the plan names only the per-edge theorems
> (``Cert.<proof-id>``). The two name spaces cannot collide (statement ids
> live in concept namespaces, proof ids in ``…Proofs``), but the plan should
> fix the spelling.


## Site Generator

The site generator is maintained in the separate ``lax-website`` repository.
It reads all three files in each database folder and emits deterministic
submission, concept, and proof pages, a searchable archive index, citations,
and concept, submission, and proof-network views. It renders Markdown, math,
annotation sections, Lean source, and proven or unproven statement status.
Records without content-bearing build output, including init reservations and
deleted tombstones, produce no submission pages.

The generator reads each record's content spec version from its manifest.
On a spec-2 record a statement card shows the statement's body — the
definition's right-hand side, which is the claim — rather than a signature
that reads ``X : Prop``. A proof card shows the proof's **telescope**: its
hypotheses in binder order and its conclusion, which is the edge as the
author wrote it. A certified record carries the mark "certified: ``lake
comparator`` (<toolchain>, <kernels>), bundle <digest>", read from
``certificate``; beneath the proof network the record's ``Challenge.lean``
is shown collapsed, beside the bundle digest and the rerun command, because
the Challenge is what makes the mark checkable by a reader. Every spec-2
environment's listing states that the concept packages a record depends on
are trusted, as today — their statements mean what their descriptions say —
and that the certificate removes lax, not those authors, from what a reader
must trust. A record with no proofs shows no mark.

Version chains are derived from ``supersedes`` claims of registered records:
a superseded submission's pages carry a banner linking to the latest version,
a Versions list shows the chain, superseded work is grouped after current
work, and its BibTeX gains a ``note = {superseded by lax-N}``. Endorsements
do not carry over; they attest specific code.

A record outside the epoch carries a notice naming its environment and the
epoch; listings put the epoch's submissions first and offer the environment
as a filter. ``index.json`` and ``environments.json`` at the site root list
the records with their state, environment, chain links, concepts, and proofs,
and the environments with their spec version and record counts, for readers
that are programs.

A paper is shown on its own page with two surfaces, the reflowed web view at
the reader's width and the PDF as printed, with a card for every marked
passage. Footnotes become sidenotes where the page has a margin. A record
whose web bundle the viewer does not understand falls back to the PDF.

``lax serve`` runs the renderer that ``lax update`` downloads, falling back
to the revision bundled with the CLI.


## Database Repository

The folder tree of the Archive Database section is the canonical state of the
archive; everything else is derived. ``lax-archive/lax-database`` is a public
Git repository. Only protected GitHub Actions publication jobs may mint the
short-lived GitHub App token that advances its default branch, and they do so
without force after revalidating the current head. ``lax sync`` clones or
fast-forwards a read-only checkout at ``~/.lax/lax-database``. The path is
deliberately visible so authors and agents can survey existing work.


## CLI

The acting GitHub account authenticates through the Lax GitHub App. Signing
in is not a setup step: the commands that reach the archive (``submit``,
``owners``, ``register``, ``delete``) run the device flow themselves when no
usable login is stored, so a machine authors, builds, and previews without
ever having authenticated. The CLI creates issues and exact command comments;
it never writes the database directly.

Every command prints one report, not a log: a title, one row per stage
where there is real waiting, and a one-line verdict, followed by notes with
their fixes. Run ids, URLs, and the tools' own transcripts appear only under
``-v``/``--verbose``; ``--no-color`` gives plain text. Piped output carries
the same words without the spinner. ``lax`` has the following commands:

**lax init [folder]** (default ``.``) starts a submission, see Actions. The
folder may hold other files (a paper, say), but init refuses if any root
entry it would create already exists; an existing ``.gitignore`` is extended
instead. Init draws a
random six-digit id, signs in to nothing, and opens no issue. The scaffold
comprises ``manifest.yaml`` (with ``id: lax-N``, the environment pins, and an
empty author list), package folders, lakefiles (with the environment's
required libraries), ``lean-toolchain``, root modules, ``abstract.md``,
``LICENSE``, and
a ``.gitignore`` covering ``build-output.json``, ``lake-manifest.json``, and
``.lake/``. In a spec-2 environment the scaffold also shows the content
rules in the smallest possible example: one concept module importing
``LaxCore`` with an ``@[lax_statement] def … : Prop`` statement, and one
proof module with a conditional proof that assumes it as a hypothesis — the
``variable``/``include`` recipe of the Proofs section — so that an author's
first build exercises an edge. ``--title`` sets the title (default: the
folder name). ``--env
<id>`` selects an active environment other than the epoch; init then states
the two environments and their registered submission counts, says that only
submissions in that environment can cite the work, and asks for the id to be
typed back, which ``--yes`` skips. A closed or unknown environment is refused
before anything is written. Init then builds or reuses the environment's warm
workspace and seeds both generated manifests and package overrides,
so plain ``lake build`` works immediately; when the workspace cannot be built
(offline), init warns and ``lax build`` retries. It may scaffold outside Git
with a warning, but the folder must enter a Git repository before ``lax
build`` or ``lax submit``.

> draft note: the plan says ``lax init`` scaffolds "the three library
> requires", while open decision 1 assumes ``CSLib`` is *allowed* so that "a
> submission that does not need it should not carry it". This draft
> scaffolds the required libraries and leaves ``CSLib`` to the author (a
> commented-out require in the lakefile would show the pin); if ``CSLib``
> becomes required, the scaffold carries it. Whether the scaffold's example
> statement and proof are emitted at all, or only as comments as the spec-1
> scaffold does, is also open.

**lax owners <target> --new-list <handle>...** replaces the owner set with the
given GitHub handles, resolved to numeric account ids (see Archive Database).
The target is a ``lax-N`` id or a submission folder. On a folder without an
issue it stores the handles in the manifest for the first submit.

**lax build [folder]** runs the local authoring pipeline through the pinned
host toolchain and writes ``build-output.json`` after a successful full
build. It skips kernel Replay by default; ``--replay`` enables it,
``--profile`` prints phase timings, and ``--build-from-source`` builds the
libraries locally when mathlib's prebuilt artifact cache cannot be fetched.
In a spec-2 environment it runs Certify (see Certification) and writes the
bundle beside ``build-output.json``, under ``.lake/`` of the submission
root, where no ignore rule needs to change. ``--only
concepts`` and ``--only proofs`` provide partial iteration builds without
replacing ``build-output.json``; proofs-only still builds concepts as its
prerequisite but skips concept Replay. In spec 2 the local ``--replay``
replays both packages — the whole-package check the archive's own run
omits (see Replay). A declared paper is compiled with the
host ``latexmk`` as a preview (skipped with a note when absent); the
archive's compile is the authority. Build warns when it wrote a generated
file no ignore rule covers; it never edits ``.gitignore``.

Build is strict by default: it refuses what the archive refuses, with the
same findings, so a default local build passes if and only if a submit
would. ``--nonstrict`` admits two edges the archive refuses, each with a
warning, so that an unregistered chain can be built locally:

- a git require on a draft record;
- a ``path`` require on a **sibling**: another local submission's package,
  under its package name, at a path relative to the requiring package. The
  sibling's lakefile is validated by the same rules as the author's own —
  package name, library pins, well-formed requires — and the library pins
  are the environment check. Its git requires are resolved as further direct
  requires; its path requires are siblings in turn. Lake builds a sibling in
  place, as it does the proof package's ``../concepts``, so the sibling's
  own builds and every dependent's share its artifacts. The sibling's
  library directory is on the Replay and Inspect search path, its modules
  are importable, and its tagged definitions are admissible statements by
  package prefix (the sibling's own build judges them). Each package sees
  only the siblings
  its own lakefile names. A path require on a sibling that the local
  database shows as registered is refused; the finding prints the git
  require to write instead.

The output of a nonstrict build records which edges it admitted and which
siblings it built, and ``lax submit`` never reuses it. Registration never
trusts local output: the GitHub Actions workflow rebuilds a submitted commit
with concept Replay mandatory.

**lax serve [folder]** runs the **site generator** and serves the result
locally. It is a long-running process that does not daemonize by default. It
prints ``http://localhost:8123/``, a **front page** that belongs to the
preview, not to the site generator. The front page states that this is a
local preview, lists the folder and every sibling reachable through its
lakefiles' ``path`` requires — id, title, environment, whether the folder has
a ``build-output.json``, and a link to its page — and shows the database
warning and the reason the last render failed, if any. It links to the
generated archive index at ``/index.html``. The folder's own page is
``http://localhost:8123/<id>/`` (``/local/`` until a build has named it).
Serve watches the complete local database and the ``build-output.json`` of
the folder and of every listed sibling; every change triggers a website
rebuild. The folder is rendered from its own ``build-output.json`` against a
synthetic draft record, so ``lax serve`` works before the first submit. A
sibling with a ``build-output.json`` is rendered the same way; one without
is listed and not rendered. When the folder and a sibling have the same id,
the folder is rendered. If the folder's ``build-output.json`` is missing,
its page shows a placeholder stating that the output has not been generated
yet; ``lax serve`` does not build. It warns when the database is missing,
stale, invalid, or unreachable. The folder's own ``paper.pdf`` and web
bundle are shown directly; a database record's are fetched by digest on
demand into ``~/.lax/papers/`` and ``~/.lax/bundles/``. ``--database-only``
omits the folder and its siblings and opens on the same front page. A taken
port is walked past; ``--port`` changes where the walk starts.

The intended workflow is to keep ``lax serve`` running while authoring and
to run ``lax build`` after each completed proof: a successful full build
replaces ``build-output.json`` and the preview regenerates. A failed or
partial build does not, so the preview stays at the last validated
milestone.

**lax submit [folder]** derives the (repository, commit, folder) triple from
the folder's git state — the remote URL, the HEAD commit, the folder's path
within the repository — and normalizes the supported providers' SCP or SSH
clone spellings to credential-free HTTPS URLs, removing a trailing ``.git``.
URLs containing credentials, ports, queries, or fragments are rejected. By default
it requires a clean worktree and a HEAD present on ``origin``. Before posting
the command it reuses a matching full local build or runs ``lax build``; a
nonstrict build's output is never reused.
``--allow-dirty`` still submits committed HEAD, excluding local changes, and
validates it in an isolated worktree. ``-f``/``--force`` skips the dirty,
pushed-HEAD, and local-build checks entirely, leaving the trusted workflow as
the only verdict. A ``supersedes`` claim that can never bind — a non-owner
actor, an unregistered target, an occupied slot — is refused before anything
is posted, as is a dependency the local database shows as a draft. Submit
always produces a replaceable draft. On the first submit of
a folder it binds the id instead (see Actions) and stops for the author to
commit the binding.

While the archive validates, submit shows the run's stage and then renders
the archive's report — the same findings, in the same form, as a local
build — with the local and remote warnings merged into one block.

The explicit form ``lax submit <lax-N> --repository <url> --commit <sha>
[--folder <path>]`` posts a validated source triple without local Git or build
checks. ``lax submit --resume [folder]`` re-derives the originating command and
durable Actions run from issue comments after a transport failure; no local job
id is required.

**lax register <target>** makes an init or draft record immutable, and **lax
delete <target>** permanently replaces it with a tombstone. Both refresh and
preflight the local database and require the user to type ``lax-N`` unless
``--yes`` is supplied. Register's preflight names what registration binds — a
``supersedes`` claim, dependencies on superseded work — and a registered
submission prints its citation key. Registration rests on the per-submit
certificate already in the record; ``lax certify --run`` before registering
is an author's tool, not a gate.

**lax sync** refreshes the local database checkout at
``~/.lax/lax-database``, see Database Repository. It is read-only with respect
to the archive and needs no authentication.

**lax port <lax-N> [folder] [--env <id>]** scaffolds the successor that moves
a submission into another environment (default: the epoch). It clones the
record's published source at its commit, gives the folder a fresh id and
renumbers every spelling of the old one, rewrites the pins to the target
environment, adds ``supersedes: lax-N``, and repoints every cross-submission
require at the dependency's own port in the target environment, naming any
dependency that has none yet. No Lean is ported: the author fixes the sources
and submits. A record already in the target environment is refused. A port
from a spec-1 into a spec-2 environment is a guided, agent-edited port of
the content as well: every ``axiom`` becomes an ``@[lax_statement] def … :
Prop``, every proof's ``conclusion`` becomes its type and its assumptions
become hypotheses, and the frontmatter goes; ``lax port`` adds the library
requires and ``import LaxCore`` and lists the statements and proofs to
rewrite, and the first ``lax build`` names each one left behind (a stray
``axiom``, a frontmatter on a helper).

**lax certify <target> [--relative-to <statement>...] [--run [--paranoid]]
[--output <folder>]** writes a certificate bundle (see Certification) and
prints the ``lake comparator`` command for it; ``--run`` runs the command,
with ``--paranoid`` adding the toolchain's bundled external kernels. The
target is a ``lax-N`` id, whose per-submit bundle is fetched by its recorded
digest, or regenerated from the record's telescopes when ``--relative-to``
is given; a proof id, whose single edge is the certificate; or a statement
id, whose certificate is the relative certificate that the statement is
proven — relative to the ``--relative-to`` statements, or outright —
composed from the local database along the proof network's witness forest.
A statement that is not proven relative to the given set is refused with
the statements left open or cyclic, as ``lax generate-prooftree`` reports
them. The command needs the local database and the target environment's
toolchain and warm workspace (``lax doctor --env``); it needs no
authentication. The bundle is written to ``--output`` (default: a folder
under ``~/.lax/certificates/`` that the report names).

> draft note: the plan fixes the target forms and the composition rule; the
> output location, the default when ``--run`` is absent (print only), and
> whether a ``lax-N`` target without ``--relative-to`` fetches or
> regenerates are this draft's choices. Whether ``lax generate-prooftree``
> survives beside ``lax certify`` for spec-2 rows, or becomes its spec-1
> counterpart only, the plan does not say.

**lax generate-prooftree <lax-N> [--output <folder>]** composes, from the local
database alone, one kernel-checked theorem per statement of the submission
from the archive's proofs, leaves upward, and reports the statements left
open or cyclic. It succeeds only when every statement depends on background
axioms alone.

**lax update** upgrades the CLI itself to the latest release and then refreshes
the local database and current Website renderer; ``lax upgrade`` is an alias.
Likewise needs no authentication.

**lax doctor** provisions and checks the machine: elan (the pinned installer,
into ``~/.elan``, without touching the shell profile), the epoch's toolchain,
its bundled kernels — ``leanchecker``, and the external checkers
``lake comparator --paranoid`` runs (``leanchecker-paranoid``,
``lean4lean``, ``nanoda``, ``con-leche``, ``con-ron``), which ship inside
the toolchain and are reported, never installed —
its warm workspace (last, since it downloads gigabytes), the database
checkout, the login, the Website renderer, and ``latexmk`` with the TeX
engines, which it reports but never installs. A registered submission on the
machine is a row of its own, checked against its own environment for pin
drift, dead package overrides, and tracked generated files. A machine that
has never signed in is a note, not a failure. ``--env <id>`` points the Lean
chain at another environment and provisions it, stating the disk cost first.
``--dry`` is the same report with every change suppressed; it still exits 1
on a failing row, so it works as a check in a script.

**lax login** uses the GitHub App device flow and accepts only the resulting
``ghu_`` user access token. Expiring credentials are refreshed with the
rotating ``ghr_`` refresh token stored under ``LAX_HOME``; generic OAuth and
personal access tokens are rejected. The user token may create issues and
comments in the control repository but has no database or Website installation
authority. **lax logout** revokes both stored tokens with GitHub before removing
them locally. Without a terminal, or with ``LAX_GITHUB_APP_USER_TOKEN`` set,
no command signs in on its own.

**lax print spec** prints this specification and **lax print instructions**
the guide to creating a submission. Both are bundled with the CLI, so the
printed text is exactly the one shipped in that release, and both print
verbatim: their reader is an agent.

> draft note: with two spec versions live, ``lax print spec`` has to choose.
> Options: print the spec of the epoch, with a flag for the other; print
> both; or print the spec of the submission folder's environment when run
> inside one. The plan does not say.


## GitHub Actions

The archive has no long-running application server. The public
``lax-archive/lax`` repository, its issues, and its GitHub Actions workflows
form the write control plane; the public database remains the read surface.

- **Authentication and commands.** The GitHub App user token lets the CLI open
  the authoritative issue or post exact ``/lax owners``, ``/lax submit``,
  ``/lax register``, ``/lax delete``, and ``/lax admin`` comments, each
  carrying the submission id. Edits do not execute. GitHub authenticates the
  actor before emitting the event; the router accepts a new issue only with
  the id marker on its first line, checks a comment's id against the stored
  issue binding, and authorizes the actor by numeric account id. It has only
  the repository-scoped workflow token and no Archive write credential.
  Records from before locally drawn ids keep their issue-number binding; the
  set of those ids is frozen in the archive's source.

- **Validation isolation.** Submit validation runs as one credential-free job
  on an ephemeral GitHub-hosted runner. Source fetching, static checks, and
  resolution happen before author code runs. Compile, Replay, Inspect,
  Certify, capture
  download/extraction, and sealing use fresh containers from a stock image
  pinned by digest. The environment's toolchain, warm workspace,
  inspector, and helper tools are installed on the VM and mounted read-only. Compile gets
  a copy of committed source plus isolated writable build directories; Replay
  (concepts only in spec 2) and Inspect read only the captured submission
  artifacts and verified dependency captures. Certify's Challenge container reads only the concept
  captures and the warm workspace; its Solution container reads those, the
  proof capture, and the Challenge export, all read-only, and runs the
  comparator without its own sandbox because the container is the sandbox.
  The runner's reusable cache is saved before any
  untrusted code executes.

- **Validation artifacts and captures.** Every validation uploads its report
  as a workflow artifact, which ``lax submit`` downloads and renders; reading
  it needs the user token's Actions read permission, and artifacts expire
  after 90 days, so a failed build's transcript is not permanent. A
  successful validation also uploads the phase profile, generated build
  output, ``capture.tar``, and the certificate bundle. Before any publication
  credential exists, a
  separate preflight parses their exact schemas and verifies the source
  commit, the runtime identity against the environment table, capture digest,
  per-file hashes, issue binding, lifecycle state, owners, stale-write inputs,
  dependency captures, and — for a spec-2 record — that the bundle's
  ``Challenge.lean`` is the one the build output quotes and that its
  theorems are the build output's edges. The protected publisher then pushes
  the capture,
  the paper PDF, the web bundle, and the certificate bundle as
  digest-addressed OCI layers to
  ``ghcr.io/lax-archive/lax-captures`` and records the digest references in
  ``build-output.json``. If the database update later loses a race, an
  orphaned blob is harmless; no uncommitted capture becomes authoritative.

- **Database publication.** Only jobs in the protected
  ``lax-database-publish`` environment can mint a short-lived Database
  Publisher installation token, restricted to ``lax-database``. After the
  credential-free preflight, the publisher re-reads the latest database head
  and repeats issue binding, authorization, lifecycle, exact-schema,
  precondition, and dependency checks. It advances the default branch without
  force and changes only the files owned by the action. Publishers may run
  concurrently; a non-fast-forward causes the job to re-read, revalidate, and
  retry rather than overwrite another update.

- **Asynchronous results.** Issue comments carry stable hidden correlation
  markers. The CLI follows the corresponding durable Actions run, shows its
  current stage, and waits for a bot-authored result. Owners and submit
  commands carry a 🚀 reaction while running and a 👍 on complete success;
  owners use that reaction as their only success result. Initialization,
  submit, register, delete, and maintainer actions retain result comments
  ending in ``<!-- lax-outcome:success|failure -->``; a failure comment is
  one paragraph with the outcome, the id, the first finding's phase and
  rule, and a link to the run — the diagnosis is in the run artifact.
  ``failure`` also covers a database commit whose website dispatch or issue
  title sync did not complete. A CLI disconnect can therefore resume from
  issue history instead of an in-memory job id.

- **Website dispatch.** The job that made the database commit mints a Website
  Dispatcher token restricted to ``lax-website``, sends the rebuild event, and
  reports whether dispatch was accepted; the Website repository owns the
  actual build and GitHub Pages deployment. A dispatch or issue-title sync
  failure is reported as an operation failure even when the canonical database
  commit already succeeded, and never rolls that commit back.

## Distribution and Deployment

The CLI is the one component users install. We distribute via npm (package
``lax-archive``), making installs and updates one-liners; ``lax update``
runs ``npm install -g lax-archive@latest`` and then refreshes the database and
current Website renderer.

Local builds shell out to the ``elan`` and ``lake`` that ``lax doctor``
installs under ``~/.elan``, falling back to PATH, and to ``git`` for source
checks and the database clone; ``lax update`` also needs ``npm``, and a paper
preview ``latexmk``. Docker is required only by trusted validation, not by
CLI authoring. The CLI speaks the GitHub App flow and API directly, so no
GitHub CLI is required, and names missing command dependencies during
preflight.

The npm CLI and ``submission.yml`` share the TypeScript validators,
inspection judgments, and the certificate generator; the workflow adds
isolated execution, mandatory concept Replay,
capture sealing, and publication. The Website renderer is built in the
separate ``lax-website`` repository and bundled from the revision pinned in
this repository, with third-party notices for the code it vendors; the
ReflowTeX fork (AGPL) is fetched at its pinned revision, never committed
here. ``release.yml`` runs checks, verifies that renderer bundle, and
publishes through npm trusted publishing on version tags; ordinary CI runs
on every push. A scheduled workflow admits new environments: it runs the
whole test gate under a candidate mathlib release tag — with, for a spec-2
row, the ``LaxCore`` and ``CSLib`` commits chosen against it — and opens a
pull request adding the table row, which reaches authors with the next
release.

### Environment variables

All lax-specific configuration is environment variables; none is needed in
normal use.

CLI:

- ``LAX_HOME`` (default ``~/.lax``): the CLI's machine state — the database
  clone (``lax-database/``), credentials, warm mathlib workspaces (``warm/``),
  compiled tools, the downloaded renderer, paper caches (``papers/``,
  ``bundles/``), the list of submission folders doctor checks
  (``submissions.json``), and update-check state.
- ``LAX_GITHUB_APP_USER_TOKEN``: an existing ``ghu_`` GitHub App user token
  used instead of stored ``lax login`` credentials (CI and agents). No
  command signs in on its own while it is set.
- ``LAX_DATABASE_URL``: override the public database clone URL;
  ``LAX_DB_URL`` remains a legacy alias.
- ``LAX_DATABASE_POLL_INTERVAL_MS``: override how often ``lax serve`` checks
  database freshness.
- ``LAX_DISABLE_UPDATE_CHECK=1``: disable the best-effort background release
  check.

GitHub Actions deployment:

- Repository variable ``LAX_REPOSITORY_ID`` fixes the immutable numeric id of
  ``lax-archive/lax``.
- The protected ``lax-database-publish`` environment provides
  ``LAX_DATABASE_APP_ID`` and ``LAX_DATABASE_APP_PRIVATE_KEY`` for an App
  installed only on ``lax-database`` with Contents write, and
  ``LAX_WEBSITE_APP_ID`` and ``LAX_WEBSITE_APP_PRIVATE_KEY`` for a different
  App installed only on ``lax-website`` with Contents write. No job that
  holds either key checks out or executes submission code.
- Repository policy requires every external action to be pinned to a full
  commit SHA. App tokens are minted only inside their protected jobs and are
  never CLI configuration or validation-job input.

Test and development seams, never set in production, may substitute the
mathlib URL and revision, immutable validation image, GitHub endpoints,
repository names, or capture registry. The standard ``ELAN_HOME`` is respected.


## Tests

Unit, integration, workflow, and end-to-end tests use bounded fake GitHub and
GHCR services, temporary Git repositories, and a small fake mathlib while
exercising the real validators, control-plane protocol, publisher, and local
CLI. A separate submission-validation smoke command runs the real pinned
toolchain path. CI builds and tests every push; the release workflow repeats
those checks before npm publication.


# The Social Layer (future work)

This section is reserved for future work and not part of this spec.

A **reviewer** is a verified ORCID identity (via OAuth) with a real-world name,
leading to trust by reputation. Reviewers act on the social layer.

## Endorsements and Flags

Reviewers can **endorse** and **flag** individual concepts. Both are public
verdicts staked on the reviewer's verified ORCID and performed explicitly on
the website — endorsement is opt-in, never implied by authorship.

**Endorsing** means signing the following attestation, displayed at the moment
of endorsement:

    I have read this concept's description and its Lean code, and I attest that
    the code faithfully formalizes the description.

    In particular, I have followed its dependencies — their descriptions, and
    their code — as deeply as necessary.


The endorser vouches for the meaning of the concept as a whole, including the
upstream context that meaning rests on. How deep to read upstream is the
endorser's judgment call — that judgment is exactly what they stake their name
on. Endorsements are revocable.

A **flag** is the opposite verdict and requires a message outlining the
problem. A flag is a staked claim, not a final verdict: it stands until the
flagger retracts it.
