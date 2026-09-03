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
Lean, Lake and mathlib.



# Submission Layout

This section gives the full rule set that all submissions in the archive must
adhere to.

Each submission carries two central files in the root folder:
``manifest.yaml``, written by the authors, and ``build-output.json``, derived by
the build.

## Archive Environment

We fix the following **archive environment**:

- ``specVersion: "1"``
- pinned Lean toolchain: ``leanprover/lean4:v4.30.0`` (the verbatim content
  of every ``lean-toolchain`` file; it also fixes the Lake version)
- trusted background imports
    - mathlib, pinned to revision ``c5ea00351c28e24afc9f0f84379aa41082b1188f``,
      present in **every** submission workspace: the concept package requires
      it at the pin (see Packages), so the whole archive shares one mathlib
      closure. Importing it remains the author's choice — presence without
      import is inert.
- concept build options
    - ``autoImplicit`` off
- proof build options
    - ``autoImplicit`` off
- allowed background axioms
    - ``propext``
    - ``Classical.choice``
    - ``Quot.sound``


## File Structure

A submission rooted at folder ``mysubmission`` with id ``Lax261`` **must**
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

Additional Rules:

- **License.** The file ``LICENSE`` in the submission root folder must contain
  an accepted license, matched against the canonical text after whitespace
  normalization. An optional copyright line at the end of the file is
  ignored. For the MVP we accept exactly one license: the **Apache License
  2.0**, the license of Lean and mathlib.

- **Abstract.** ``abstract.md`` must be non-empty. It is rendered as markdown
  and shown prominently on the website.

- **Files.** ``build-output.json`` and ``lake-manifest.json`` must not be
  checked in. A local build leaving the files behind is fine. Files beyond the
  pictured layout (a README, etc) are allowed and ignored by the archive.

## manifest.yaml

The file ``manifest.yaml`` must contain the following keys and adhere to the following rules.

- ``specVersion``: version of the spec this submission adheres to
- ``mathlibVersion``: version the submission was built against
- ``leanVersion``: version the submission was built against

- ``id``: The archive-assigned unique id. It must be of the form ``LaxN`` for
  a positive natural number N written without leading zeros. Ids are
  deliberately opaque; this prevents the squatting of nice names like
  ``RamseyTheory``.

- ``title``: A non-unique title, like the title of the paper the submission formalizes.

- ``authors``: An ordered, possibly empty, list of author entries. Each entry is a
  tuple with a required ``name`` (display name) and optional ``orcid`` and
  ``github`` identifiers. Used for credit only, not rights-management.

- ``bibEntries``: a possibly empty list of strings, each a single BibTeX
  entry verbatim, as it would appear in a ``.bib`` file.

Additional Rules:
- ``specVersion``, ``leanVersion``, ``mathlibVersion``: must match the
  archive environment for now. ``leanVersion`` holds the version tag
  (``v4.30.0``); the full toolchain name (``leanprover/lean4:v4.30.0``)
  appears only in the ``lean-toolchain`` files.
- No keys beyond the ones listed here are allowed.

Example:

    specVersion: "1"
    id: Lax261             
    leanVersion: "v4.30.0"
    mathlibVersion: "c5ea00351c28e24afc9f0f84379aa41082b1188f"
    title: My Submission
    authors:
      - name: Alice Smith
        orcid: "0000-0002-1825-0097"
        github: alice
      - name: Bob
        github: bob
    bibEntries: []



## Packages

Each submission ``Lax261`` contains two Lake packages: a **concept
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

- **Dependencies.** Besides mathlib, concept packages may require only
  concept packages; proof packages may require both concept and proof
  packages. We issue a warning whenever a proof package is required.
  Note that a proof package is not required to depend on its own concept package! It might proof some conjectures of some other unrelated submission only.
  Each package **must** require mathlib — under the name ``mathlib``
  from its canonical URL, pinned to the archive-wide revision.
  Concept and proof packages of other submissions are added by pinning the
  full commit hash and subfolder of the submission's repository. Every such
  require resolves by name: by the fixed-names rule the require name is the
  required submission's package name and thereby names a record in the
  database (which keeps two submissions at different folders of one commit
  apart). The require's ``(git, rev, subDir)`` must equal that record's
  current source — ``repository``, ``commit``, and ``folder`` joined with
  ``concepts`` or ``proofs`` — verbatim: write the canonical ``repository``
  spelling (see ``lax submit``), not an ssh alias of it. A draft dependency
  is admitted with a warning; registration admits only registered
  dependencies (see Lifecycle). Only
  exception: the proof package may require its own concept package via the
  relative path ``../concepts``.

- **Imports.** A module may import only modules of its own package, of Lean
  core (``Init``, ``Std``, ``Lean``), of mathlib, and of the packages its
  package requires. Modules of mathlib's own dependencies (``Batteries``,
  ``Aesop``, ``Qq``, …) are not importable; import the corresponding mathlib
  module instead. Enforcement is a prefix check on each module's imports as
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
  comment, a stray ``#check``) is tolerated, like the concept dialect:
  unreadable, not unsound. One caveat on "exactly": a Lean module without
  imports implicitly imports ``Init``, so the root module of an empty
  package records that single import, which the check ignores.

- **Empty submission.** A submission may contain no concepts and no proofs.

- **Pinned toolchain.** ``lean-toolchain`` must contain the archive-wide
  toolchain verbatim.

- **Builds.** Both packages must build: ``lake build`` succeeds in
  ``concepts/`` and in ``proofs/``. Lean warnings do not fail a submission.

- **The manifest is derived.** ``lake-manifest.json`` is a lax-generated
  file, like ``build-output.json``: ``lax init`` and ``lax build`` write it
  from the lakefile's requires plus the archive pins (see Build Pipeline,
  Provision), it is never authored, and it must not be checked in. Authors
  never run ``lake update`` — with a complete manifest in place, plain
  ``lake build`` resolves nothing and needs none.

Example ``lakefile.toml`` of a concept package:

    # mysubmission/concepts/lakefile.toml
    name = "Lax261"
    defaultTargets = ["Lax261"]

    [leanOptions]
    autoImplicit = false

    # mandatory: mathlib at the archive-wide pin
    [[require]]
    name = "mathlib"
    git = "https://github.com/leanprover-community/mathlib4"
    rev = "c5ea00351c28e24afc9f0f84379aa41082b1188f"

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

## Namespaces

Each submission with id ``Lax261`` owns two top-level namespaces: its concepts 
live in ``Lax261`` and its proofs in ``Lax261Proofs``. 

## Concepts

A **concept** is a Lean module of the concept package; every module except the
root module is one, and must carry the concept annotation (see Annotations).
The concept ``Myconcept`` of submission ``Lax261`` is the module
``Lax261.Myconcept``, stored at Lake's canonical path
``concepts/Lax261/Myconcept.lean``. Concepts cannot be nested in subfolders.

The **statements** of a concept are the axioms whose module of origin it is.

A concept owns its module name as a namespace: every name the module declares
carries the module name as a prefix, e.g. ``Lax261.Myconcept.Ramsey``. This
one prefix condition is the whole rule — deeper subnamespaces are
automatically fine.

A concept may import mathlib modules and other concept modules (of the same
or of other submissions). These imports form the **concept DAG** (acyclic for
free, since Lean imports are).

Additional Rules:

- **Axiom-free.** The axiom set (``#print axioms``) of every declaration of
  the concept package may contain only the archive environment's background
  axioms — plus, for a statement, the statement itself, which an axiom always
  reports. No other statement may occur: concepts declare statements but
  never use them, so no concept builds on an unproven claim.

## Proofs

A **proof** is a declaration of the proof package whose docstring carries
yaml frontmatter (see Annotations); every other declaration is a helper,
which the archive ignores. Frontmatter is the opt-in: helpers may carry
ordinary docstrings, and any mistake in a frontmatter — an unrecognized key,
a missing ``conclusion``, a declaration of the wrong kind beneath it — is a
loud build error, never a silently ignored proof.

The frontmatter's ``conclusion`` key names the proof's **conclusion**, the
statement it discharges. Its **assumptions** are the statements in its axiom
set (``#print axioms``).

Rules:

- **Theorem kind.** A proof must be of theorem kind — the kernel's notion,
  not the surface syntax, so mathlib's ``lemma`` qualifies.

- **Conclusion.** The ``conclusion`` id resolves to a statement of a concept
  package the proof package requires, present in the proof's environment —
  i.e. the proof's module (transitively) imports the concept module
  declaring it. The proof's type is definitionally equal to the statement's
  type (kernel check).

- **Assumptions cross-check.** The optional ``assumptions`` key, when
  present, must equal the computed assumption set — a redundant sanity
  check for authors, not an input.

- **Axiom hygiene.** Every axiom in the axiom set of any declaration of the
  proof package — proof or helper — is a background axiom or a statement of
  a required concept package. Statements of packages that are only
  transitively reachable do not qualify: to assume a statement, require its
  package.

- **Namespace.** Every name declared in the proof package carries the
  prefix ``Lax261Proofs``, as for concepts.

Together, the proofs weave the statements of the archive into the **proof
network**: the directed hypergraph over all statements with a hyperedge
(A → c) for every proof with assumption set A and conclusion c. A statement
is **proven** if it is the conclusion of some proof all of whose assumptions
are (recursively) proven, and **unproven** otherwise — a least fixed point,
so statements in a dependency cycle do not prove each other. More generally, a
statement is **proven relative to** a set C of statements if it becomes
proven once the statements in C are taken as proven.

## Annotations

We annotate concepts and proofs. A concept is annotated by its module docstring
``/-! … -/``, of which we allow at most one per module. A proof is annotated by
the usual docstring ``/-- … -/``.

Each annotation is a docstring that we parse as markdown with yaml frontmatter
(a common pattern from static site generators). When later parsing this
docstring into key-value pairs, the markdown after the frontmatter is placed
into the ``description`` key. The frontmatter grammar is a fixed minimal
subset of yaml — scalar ``key: value`` lines, plus a plain list of names for
``assumptions`` — because it is parsed by the inspector in core-only Lean
(see Inspection Scaffolding); anything beyond the subset is a build error,
never a guess. The recognized keys (the list may later be
extended):

Concept
    - ``title`` (required): natural-language name of the mathematical object,
      like "Ramsey's Theorem"
    - ``description`` (required): the natural-language description of that
      object. The whole validity of the archive rests on the assumption that
      the Lean side of the concept faithfully represents this description.

Proof
    - ``conclusion`` (required)
    - ``assumptions`` (optional): a yaml list of fully qualified statement
      names, see Proofs
    - ``description`` (optional): additional information, like attribution or
      the high-level idea.

Frontmatter with an unrecognized key leads to build errors.

An example concept module ``concepts/Lax261/Myconcept.lean``:

    import Mathlib.Combinatorics.SimpleGraph.Basic
    import Lax42.Colorings

    /-!
    ---
    title: Title of the concept
    ---
    description of the concept
    -/

    namespace Lax261.Myconcept

    /-- an ordinary Lean docstring; no frontmatter -/
    axiom X [...]

    [...]

    end Lax261.Myconcept


An example module within the proof package:

    import Lax261.Myconcept

    namespace Lax261Proofs

    /--
    ---
    conclusion: Lax261.Myconcept.X
    ---
    description of proof Q
    -/
    theorem Q ...

    end Lax261Proofs


# Archive Database

The archive stores one folder per allocated id. ``LaxN/record.json`` holds the
mutable lifecycle data: state, owner set, timestamps, the current (repository,
commit, folder) triple. ``LaxN/build-output.json`` holds the build output:
absent in the init state, overwritten on every draft submit (drafts are shown
on the website), frozen on registration. 

Example ``record.json``

    {
      "specVersion": "1",
      "id": "Lax261",
      "state": "registered",
      "createdAt": "2026-07-01T12:00:00Z",
      "registeredAt": "2026-07-19T09:30:00Z",
      "owners": [
        { "githubId": 583231, "handle": "alice" },
        { "githubId": 913874, "handle": "bob" }
      ],
      "source": {
        "repository": "https://github.com/alice/mysubmission",
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "folder": "."
      }
    }

- ``owners``: GitHub accounts, non-empty, immutable after registration.
  Stored as numeric account id (handles are renameable) plus the handle for
  display.
- ``createdAt``, ``registeredAt``: UTC timestamps of init and registration;
  ``registeredAt`` is absent before registration.
- ``source``: the (repository, commit, folder) triple; absent in the init
  state, frozen on registration.



Example of ``build-output.json``

    {
      "specVersion": "1",
      "id": "Lax261",
      "manifest": { ... },
      "abstract": "...",
      "requiredByConcepts": ["Lax42"],
      "requiredByProofs": ["Lax42", "Lax42Proofs"],
      "concepts": [ ... ],
      "proofs": [ ... ]
    }

- ``manifest``: the parsed content of ``manifest.yaml``.
- ``abstract``: the verbatim content of ``abstract.md``, so the website
  renders it without repository access.
- ``requiredByConcepts`` lists all packages required by the concept package,
  and ``requiredByProofs`` lists the packages required by the proofs package.

Each entry of ``concepts``:

    {
      "id": "Lax261.Myconcept",
      "path": "concepts/Lax261/Myconcept.lean",
      "title": "...",
      "description": "...",
      "imports": ["Lax42.Colorings"],
      "sourceText": "...",
      "statements": [
        {
          "id": "Lax261.Myconcept.X",
          "signature": "X : ..."
        }
      ]
    }

``title`` and ``description`` come from the concept annotation, where both are
required. ``imports`` lists imported concept modules only — mathlib imports are
dropped. ``sourceText`` is the verbatim file content, so the website can
display concept code without access to the repository. ``statements`` lists the
concept's axioms with their pretty-printed types; the website marks each proven
or unproven.

Each entry of ``proofs``:

    {
      "id": "Lax261Proofs.Q",
      "path": "proofs/Lax261Proofs/Basic.lean",
      "conclusion": "Lax261.Myconcept.X",
      "assumptions": ["Lax42.Colorings.Somestatement"],
      "description": "..."
    }

``assumptions`` is always the pipeline-computed set, regardless of whether the
author supplied the redundant ``assumptions`` key. Proof entries carry no
``sourceText``: the website lists proofs, it does not display their code.

The file is deterministic: every list is sorted lexicographically, concepts,
statements and proofs by ``id`` and the rest by value.


# The Archival Layer

An **owner** is a GitHub account listed in a submission's owner set, and is
thereby allowed to act on the submission (e.g., submitting and editing).
Owners act on the archival layer.

The archive does not host submissions, it references them: a submission is a
folder together with a commit hash in a public git repository. Work thus stays
in the authors' repositories and attribution is clear. (To guard against link
rot, we may later keep backup copies, e.g. via
https://archive.softwareheritage.org/save/.)

## Lifecycle

Submissions can be in three possible states within our database.

**init:** an id and owner set have been allocated for this submission, but
nothing has been uploaded yet.

**draft:** visible on the website, overwritable by its owners, not citable,
not reviewable. Usable as a dependency only by other drafts: registration
requires registered dependencies. A re-draft moves the record's source
triple, so downstream drafts fail resolution until they update their pin.

**registered:** immutable, citable, reviewable. The normal published state.

The only state transitions are:

- ``-> init``,
- ``init -> draft``
- ``init -> registered``
- ``draft -> draft``
- ``draft -> registered``

## Actions

Every archive action happens via our CLI tool. It has three write actions:
``init`` allocates an id, ``submit`` uploads or registers content, and
``set-owners`` edits the owner set.

**Init.** ``lax init`` takes an empty local folder. The archive reserves the
next free id ``LaxN`` and creates a record in the init state whose
owner set contains exactly the authenticated GitHub account. The CLI then
scaffolds the complete submission layout for that id (see CLI).

**Set-owners.** ``lax set-owners`` replaces the owner set of a submission in
the init or draft state. The authenticated GitHub account must be in the
current owner set and may not remove itself. The owner set becomes immutable on
registration.

**Submit.** ``lax submit`` hands the archive a (repository, commit, folder)
triple. The folder must contain a complete valid manifest whose ``id`` equals
the id of the record being submitted to. That record must be in the init or
draft state, and the authenticated GitHub account must occur in its stored
owner set.

- Without ``--register``, a successful submit puts the submission in the
  draft state and replaces its previous (repository, commit, folder) triple
  and mutable manifest metadata.
- With ``--register``, a successful submit registers the submission and
  freezes its triple, manifest, concepts, and proofs.





# Implementation

- The **build pipeline** checks a submission against this spec and derives its
  ``build-output.json``. It is the sole authority on what this spec means.

- The **site generator** turns the database into the website.

- The **database repository** holds the archive's state.

- The **CLI** ``lax`` is the only thing authors and agents ever touch.

- The **archive server** is the archive's single piece of infrastructure. It
  serves a small HTTPS API to the CLI, runs build pipeline and site generator
  centrally, and is the sole writer of the database repository.

## The Built Environment: A Primer

The target audience for this spec are graph theory reserachers with no deep
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
an environment notion — a statement is an axiom, theorem-ness is the
kernel's kind, docstrings are persisted data — and why rules that only the
surface syntax could decide were dropped (see Decisions). The generated
declarations are harmless throughout: they carry no docstrings (so they are
never proofs), their axiom sets are empty or background, and their names
extend the parent declaration's name.

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

## Build Pipeline

The pipeline operates directly on the submission folder. There are no shadow
workspaces and no third lakefile: the two packages are the only workspaces.

It runs multiple phases. Violations are collected, not failed fast, so the final
report lists every violated rule. A phase with violations aborts the
subsequent phases.

- **Static validation** (milliseconds, no network): folder layout, license,
  ``abstract.md``, manifest schema, ``lean-toolchain``, the lakefile whitelist
  of the Packages section, and that no generated file is tracked by
  git — when the folder is not inside a git repository, this check is skipped
  with a warning. This phase also derives each package's **module
  inventory**: the root module plus one module per ``.lean`` file under
  the package's module folder, read off the file paths via Lake's
  canonical mapping (``Lax261/Foo/Bar.lean`` is ``Lax261.Foo.Bar``). The
  inventory is the pipeline's sole answer to "which modules does this
  package contain": Replay's root target and Inspect's import list are
  taken from it, never rediscovered from build artifacts — those are
  written by Compile, i.e. by attacker code. The import-related checks
  (the import rule, root-module exactness) are deliberately not here:
  imports are taken from the built environment and judged at Inspect, so
  the pipeline never parses source.

- **Resolution** (milliseconds, no network): Check that every require
  resolves by name to a draft or registered submission whose current source
  triple matches (see Packages, Dependencies) — via ``~/.lax/db`` locally,
  via local checkout on server; under a registering submit, draft
  dependencies are rejected. A local miss may just mean a stale database, so
  the CLI suggests ``lax pull-db`` and a retry before reporting the
  violation.

- **Provision:** share the **warm mathlib environment** into the two
  workspaces. The warm workspace — a lax-owned Lake workspace requiring
  mathlib at the pin, with prebuilt artifacts materialized at canonical
  paths — is built once per machine (locally under ``~/.lax/warm``, keyed by
  toolchain and mathlib revision; on the server by ``lax-server warm`` into
  the trusted store). Locally its ``.lake/packages`` tree is shared into each
  package as a **hardlink farm**: directories are recreated per project, only
  file inodes are shared, and the shared files carry no write permission —
  so a build can create its own files freely, while any in-place write to
  shared content fails loudly instead of corrupting the store. (On the
  server the packages are symlinked instead, which is safe only under the
  sandbox's read-only mount; see Archive Server.) Provision also (re)writes
  each package's ``lake-manifest.json`` from its validated requires plus the
  warm workspace's locked manifest, so lake performs no dependency
  resolution of its own. ``lax init`` runs the same provisioning on the
  fresh scaffold: the very first ``lake build`` after init — with or without
  lax — clones and downloads nothing.

- **Compile:** ``lake build`` in ``concepts/`` first, then in ``proofs/``. When
  the concepts build fails, the proofs build is skipped. Thanks to
  Provision, lake resolves nothing and compiles only the submission's own
  modules; the only remaining network uses are fetching the (small) pinned
  submission dependencies lake finds missing from the manifest, and, on a
  fresh machine, the toolchain download via ``elan`` and the one-time warm
  build. A failing build is a violation of the Packages section's build
  rule; the build transcript is reprinted to stdout so the user can act on
  it.

- **Replay:** re-check every declaration of the submission's two packages
  with ``leanchecker``, the kernel checker that ships inside the pinned
  toolchain — shelled out to, not reimplemented. Leanchecker treats a target
  as a module-name prefix, discovers every matching olean, deduplicates the
  result, and replays the modules concurrently. It therefore runs once per
  package on Static validation's root module. ``leanchecker`` is invoked
  directly, with a search path the pipeline composes itself — locally over
  the workspace lax provisioned (the two packages, the dependency clones,
  the warm mathlib environment), on the server over the trusted store (see
  Archive Server). ``lake env`` is never used: it would derive the search
  path from workspace files Compile wrote.
  Static validation guarantees every inventory module lies
  beneath that prefix; the target never comes from the root's recorded imports
  or anything else Compile wrote. The checker's default mode checks each
  discovered module against its imported environment; the imports themselves
  are not replayed (that would be ``--fresh``, which we do not use). A module
  of the inventory with no artifact in the workspace is a violation (usually
  the trace of a root module that fails to import it). Trusting the imports is
  sound only by provenance: mathlib and core are the pinned, trusted background, and
  the packages of other submissions were replayed at their own
  registration — provided the oleans in the workspace are really those.
  The local authoring pipeline skips Replay by default for fast iteration;
  ``lax build --replay`` opts into the same kernel check.
  The server always runs Replay. On the server, whose run alone gates
  registration, Replay and Inspect never read a dependency
  artifact Compile produced but only artifacts provisioned from the
  trusted store (see Archive Server). Replay exists because Compile ran
  arbitrary submission code, which can persist declarations the kernel
  never checked (``set_option debug.skipKernelTC``, unchecked environment
  APIs); replay closes exactly that hole. What no replay mode can do is
  authenticate imports: an axiom is kernel-valid whatever its type, so
  even ``--fresh`` cannot tell a forged upstream statement from the
  registered one (see Decisions) — hence provisioning.

- **Inspect:** extract environment facts with the ``Lax.Inspector``
  executable, then judge every remaining rule in the CLI — including the
  import rule and root-module exactness — see below.

- **Emit:** write ``build-output.json`` into the root of the submission.

In the authoritative server pipeline, Compile, Replay, and Inspect form a
trust chain. Compile is where untrusted code runs; nothing it outputs is
trustworthy on its own, because the submission's own elaboration wrote it.
Replay authenticates the oleans'
kernel-level content relative to their imports — every declaration
type-checks against the imported environment — and no more; Inspect
reports what the oleans say; the CLI decides whether that is admissible.
The imports themselves the chain cannot authenticate, only inherit: on the
server they are provisioned from the trusted artifact store (see Archive
Server), so the background Replay checks against is the one registration
once checked.

The inspector's facts accordingly carry two grades of trust.
**Kernel-grade:** kinds, types, values, and everything recomputed from them
— axiom sets, defeq — which server Replay makes impossible to forge within
the submission's own packages; for imported packages the same facts are
authentic by provisioning, not by replay.
**Metadata-grade:** import lists, constant-list membership, docstrings —
artifact data a malicious Compile could in principle fabricate. The rules
lean on metadata only where forgery cannot make a false thing true:
docstrings are authored content anyway, a forged import list can hide at
worst an editorial violation, and every cross-package claim is checked
against the database, never against the workspace (see Inspection
Internals). Source-structural facts — layout, lakefiles, manifest — never
pass through the oleans at all; the CLI reads the files directly. The chain
bottoms out where the archive's trust always bottoms out: Lean's kernel,
the pinned mathlib revision, and the server's custody of the artifacts
beneath the submission.


### Inspection Scaffolding

All archive-side meta-programming lives in ``Lax.Inspector``, a Lean
package providing one executable: pinned to the archive toolchain,
importing only Lean core, never mathlib. (Replay needs no counterpart —
``leanchecker`` ships inside the toolchain itself.) The inspector's source
ships with the CLI; the first ``lax build`` on a machine compiles it into
``~/.lax/tools/<cli-version>/`` and every later run of that CLI version
reuses it — the version in the path is what makes an upgraded CLI recompile
instead of running a stale binary.

An executable, never an elaborated command: the inspector loads the
package's oleans directly and executes no code originating outside its own
binary and Lean core. Importing a module must not run its ``initialize``
blocks — arbitrary interpreted IO — and nothing imported may be evaluated,
because once untrusted code runs in the inspecting process, nothing that
process writes is authentic (see Decisions). What remains is enough:
docstrings, module docs, and constant lists are persisted data readable
through core's built-in machinery, axiom walks are pure traversals, and
defeq is kernel reduction, not interpretation.

The boundary between inspector and CLI is drawn by capability: the inspector computes
exactly the facts the CLI cannot — everything whose evaluation needs the
loaded environment or the kernel — and the CLI, which alone holds the
archive context (the verified ``[[require]]`` set, the manifest, the
database), judges every rule. The inspector decides nothing about validity:
a failed defeq or a malformed frontmatter appears in the report as a fact
and becomes a violation only in the CLI, the sole emitter of violations.

One placement follows from this and deserves its reason spelled out:
frontmatter is parsed by the inspector, not the CLI. The kernel facts about
a proof — does its ``conclusion`` resolve, does defeq hold — are indexed by
a name that sits inside its docstring's frontmatter, so whoever parses the
frontmatter determines the number of passes over the environment: parsing
in the CLI would force a second inspector run to feed the names back in.
Parsing in the
inspector keeps inspection single-pass, and the report carries structured
annotations rather than raw docstrings, so the frontmatter grammar (see
Annotations) is implemented exactly once.

Inspection runs once per package: the executable is invoked with the
package's module inventory (see Static validation) and an output path as
its arguments, under the same pipeline-composed search path as Replay —
never ``lake env``. The executable imports the inventory's modules with
initializer execution disabled, inspects the resulting environment, and
writes one JSON report to the output path. Importing the inventory rather
than the root module anchors coverage to the file tree: a module the root
fails to import is still inspected — and convicts the root — instead of
silently dropping out of the environment. Statement
signatures are pretty-printed with core notation only: delaborators and
unexpanders are imported code, and running mathlib's would mean running the
submission's too (the recorded upgrade path is in Decisions). The report
contains:

- per module of the package: its direct imports as recorded in the
  environment header — this is where all import data in the pipeline comes
  from — and its module docstrings, frontmatter-parsed into annotations
  (parse problems are reported as facts like everything else);

- per declaration whose module of origin lies in the package: name, kind,
  module of origin, axiom set, whether the name is user-level (internal
  details flagged, private names un-mangled), and its docstring parsed the
  same way;

- per declaration whose frontmatter carries a ``conclusion``, the kernel
  facts: whether the name resolves, whether it names an axiom and from
  which module, whether that module lies among the transitive imports of
  the declaration's own module, and whether the declaration's type is
  definitionally equal to the statement's type;

- the pretty-printed types of the package's axioms.

The report is a pure function of the workspace's oleans, the module
inventory, and the inspector version: the inventory comes from the file
tree, and no archive context flows into the invocation, so the same built
workspace always yields the same report.

### Inspection Internals

The primer supplies every notion the pipeline needs; this subsection spells
out how each check reduces to a CLI-side judgment over the reported facts.

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
the CLI, one comparison against an allowed set — the only question is what
is allowed.

- In the concept run, the allowed set is the background axioms plus the
  declaration itself (an axiom always reports itself, see Axiom-free). No
  knowledge of other submissions is needed: statements never occur in
  concept axiom sets, so this run tells nothing apart.

- In the proof run, the allowed set is the background axioms plus the
  statements of required concept packages. An axiom counts as such a
  statement iff its module of origin lies in a required concept package — a
  prefix test of the module name against the package names whose
  ``[[require]]`` entries Resolution has just verified. Leaning on the
  fixed-names rule here is sound because every verified entry points at a
  draft or registered submission, and its submit's server pipeline enforced
  that rule on it. One
  cross-check guards the metadata: the axiom's name must also appear among
  the ``statements`` in that submission's ``build-output.json`` in the
  database — the database, not the workspace, is the authority on another
  submission's statements, so a forged module masquerading under a required
  package's name classifies as nothing. The name comparison alone would not
  survive a forgery that keeps the registered names and changes the types
  beneath them; it is sound because the upstream oleans themselves are
  authentic where the verdict counts — provisioned from the trusted store
  on the server (see Archive Server, Decisions).

Anything outside the allowed set is a violation. In the proof run this is
what catches a stray ``axiom`` in the proof package, an unexpected axiom
arriving through mathlib, or a statement used without requiring its package,
instead of silently counting any of them as an assumption.

**The namespace check.** Restrict the enumeration to user-level names — drop
the internal details, un-mangle the private names; the boundary from the
primer — and the check is a single prefix test: the module name for
concepts, the package name for proofs. Generated declarations pass because
their names extend their parent's; realized lemmas for imported constants
are internal details and drop out before the test; a declaration escaping
via ``_root_.`` fails, which is the point of the rule.

**The import rule and the root module.** The reported per-module imports
replace any reading of import lines from source. The import rule is a
prefix test in the CLI: an import's first component identifies its package
(the fixed-names rule), and the allowed set follows from the verified
``[[require]]`` entries. Root-module exactness is three facts from the same
report: the root module imports exactly the other modules of the inventory
(tolerating the implicit ``Init`` of an empty package), contributes no
declarations, and carries no module docstring. No separate file-tree
cross-check is needed: the inventory *is* the file tree, and Replay and
Inspect enumerate exactly it — a source file the root fails to pull in is
still replayed and inspected, and a root import naming a module outside
the inventory fails exactness directly.

**The proof checks.** A candidate proof arrives in the report with its
parsed frontmatter and its kernel facts, and the CLI adds the context: the
conclusion must name an axiom whose module lies in a required concept
package (the same prefix test as above) and be reachable through the proof
module's transitive imports, defeq must hold, the declaration must be of
theorem kind; the ``assumptions`` cross-check compares the frontmatter's
claim against the statements in the reported axiom set. Each fact that
comes back false is one violation.

**The pipeline never parses Lean.** Every unit the report contains is
environment data: a concept is a module, a statement is an axiom
(``ConstantInfo.axiomInfo``) from a concept module, theorem-ness is the
kernel's kind, imports are the environment header's module data, and the
annotations are persisted docstrings (``getModuleDoc?`` for modules,
``findDocString?`` for declarations). So proof-hood is data too: the
inspector spots frontmatter in a docstring by string inspection, not by
parsing Lean. No component of the pipeline reads source as Lean at all;
Emit copies files verbatim into ``sourceText``, which is a copy, not a
parse.


## Site Generator

The site generator is a static site builder: it reads the ``record.json`` and
``build-output.json`` of the database and emits pages. One per submission
(abstract, authors, bib entry, and its concepts with title, description, Lean
source, and statement signatures), one per concept, and index pages listing
submissions and browsing the concept DAG and the proof network, marking each
statement proven or unproven.


## Database Repository

The folder tree of the Archive Database section is the canonical state of the
archive; everything else (website, indexes) is derived. The database is a
single public git repository with a single writer — the archive server — and
every user holds a read-only clone of it at ``~/.lax/db``. The path is
deliberately visible, so AI agents can use it to survey existing submissions
and find prior work to build upon. Installing the CLI clones the repository.


## CLI

The acting GitHub account authenticates via GitHub OAuth: ``lax login`` runs
the device flow and stores the resulting token. ``lax`` has the following
commands:

**lax init [folder]** (default ``.``) starts a submission, see Actions. The
folder must be empty or not yet exist; otherwise init refuses. The folder is
checked before the archive is contacted, so a refused init burns no id. The scaffold
comprises ``manifest.yaml`` (with ``id: LaxN`` and the environment pins),
package folders, lakefiles (with the mandatory mathlib require), ``lean-toolchain``,
root modules, ``abstract.md``, ``LICENSE``, and a ``.gitignore`` covering
``build-output.json``, ``lake-manifest.json``, and ``.lake/``. Init then
provisions both packages from the warm mathlib environment (see Build
Pipeline, Provision), building it first on a machine that has none — the
one download of gigabytes, shared by every submission on the machine. Init
warns when the folder is not inside a git repository. The result passes
``lax build`` as an empty submission, and plain ``lake build`` works
immediately.

**lax set-owners [folder] --new-list <handle>...** (default ``.``) replaces
the owner set with the given GitHub handles (resolved to numeric account ids,
see Archive Database), see Actions. The submission is identified by the ``id``
in the folder's ``manifest.yaml``.

**lax build [folder]** runs the local authoring pipeline and on success writes
``build-output.json``. It skips kernel Replay by default for fast iteration;
``--replay`` enables it. Any violation in the phases that run fails with a
nonzero exit and a report listing every violated rule. Registration never
trusts this local result: the server reruns the pipeline with Replay mandatory.

**lax serve [folder]** runs the **site generator** and serves the result
locally. It is a long-running process that does not daemonize by default. It
watches both the local database and the submission folder for changes: the
submission's ``build-output.json``, and the ``record.json`` of registered
submissions. Every change triggers a website rebuild. The local folder is
rendered from its own ``build-output.json`` against a synthetic draft record,
so ``lax serve`` works before ``lax init`` has allocated an id. If
``build-output.json`` is missing, the website shows a placeholder stating that
the output has not been generated yet; ``lax serve`` does not build.

**Continuous preview while authoring.** Keep ``lax serve`` running in one
terminal and open the URL it prints. After each successfully completed proof
or meaningful milestone, authors and automated proof-building agents should
run a full build of the submission in another terminal:

```sh
# Terminal 1: keep the preview server running.
lax serve path/to/submission

# Terminal 2: run after each completed proof or meaningful milestone.
lax build path/to/submission
```

Each successful full build atomically replaces ``build-output.json`` and
therefore causes ``lax serve`` to regenerate the preview. A failed build, or a
partial ``lax build --only concepts`` or ``lax build --only proofs``, does not
replace ``build-output.json``; the preview intentionally remains at the last
successfully validated milestone. Reload an already open browser page to see
the regenerated checkpoint.

**lax submit [folder]** derives the (repository, commit, folder) triple from
the folder's git state — the remote URL, the HEAD commit, the folder's path
within the repository — and hands it to the archive. Source repositories must
be publicly fetchable over HTTPS from ``github.com``, ``gitlab.com``,
``codeberg.org``, or ``bitbucket.org``. GitHub, Codeberg, and Bitbucket paths
contain exactly an owner/workspace and repository; GitLab paths may include
nested groups. The remote URL is normalized to the archive's canonical
spelling: the providers' ``git@host:path`` and ``ssh://git@host/path`` clone
URLs become credential-free ``https://host/path`` URLs, with a trailing slash
or ``.git`` removed. URLs containing credentials, ports, queries, or fragments
are not accepted. A registered ``repository`` is therefore always in
canonical form. It refuses if HEAD is not present on the remote. It also
refuses a dirty worktree unless ``--allow-dirty`` is given; this permits
submission of the committed tree but does not include local changes, because
the source triple still identifies the committed HEAD. Without
``--register`` it requests the draft state, with it registration; on success
the archive updates the record as described in Lifecycle. Once the server has
accepted a job, a polling connection failure prints the job id and
``lax submit --resume <job-id>`` reattaches to that job so its eventual build
report can still be retrieved.

**lax pull-db** refreshes the local database checkout at ``~/.lax/db``, see
Database Repository. It is read-only with respect to the archive and needs no authentication.

**lax update** upgrades the CLI itself to the latest release and then refreshes
the local database, see Distribution. Likewise needs no authentication.

**lax login** authorizes the CLI with the acting GitHub account through the
OAuth device flow: it prints a code and a github.com URL, and on authorization
stores the token under ``LAX_HOME``. The flow requests **no scopes** — the
archive learns the account's identity and nothing more, and can never reach
the user's repositories. **lax logout** forgets the stored token.

**lax spec** prints this specification. The text is embedded in the binary at
build time, so the printed spec is exactly the one that binary enforces.
Useful for agents authoring submissions.


## Archive Server

One server does everything the archive does centrally: it answers the CLI's
write requests, owns the database repository, and puts the website online.

- **Authentication.** The CLI sends the user's GitHub OAuth token (from
  ``lax login``) with every write request. The server verifies the
  token against GitHub and resolves it to the numeric account id that all
  ownership checks run against.

- **Endpoints.** One per write action: ``POST /init``, ``POST /set-owners``,
  ``POST /submit`` (with a ``register`` flag), plus ``GET /jobs/<id>`` for
  polling a submit (see Async submit). These three write commands are the only
  ones that leave the user's machine. Reading *archive content* needs no server
  at all — it goes through the public database repository (``lax pull-db``);
  the server answers no content queries.

- **Build Pipeline.** Compile executes untrusted code (elaboration,
  import-time initializers) — not only the submission's own, but that of
  every upstream submission it imports. Replay and Inspect execute no
  untrusted code but consume attacker-shaped oleans, whose loading is
  unsafe deserialization. The server runs all three sandboxed, and the
  sandbox is **mandatory**: the server refuses to start without it, and the
  pipeline refuses to run. Compile moreover runs on a **copy** of the cloned
  checkout: afterwards only the two packages' own inventory oleans are
  extracted (still inside the sandbox) and placed at their canonical paths
  in the pristine checkout, which Replay, Inspect, and Emit then use. This
  keeps the ``sourceText`` Emit records the committed source — without the
  copy, a submission's build could rewrite its own files after elaboration,
  and the website would display source that differs from what the kernel
  checked, breaking exactly the faithful-display property endorsers rely
  on. This is not only host protection — the job
  workspaces are seeded with symlinks into the trusted store, which is
  sound only because the sandbox mounts the store read-only. The sandbox
  protects the host and the store, not the report: authenticity comes from
  the trust chain of the Build Pipeline section together with the trusted
  artifact store below, and a malformed olean is a crash and a failed
  build, not a compromise.

- **Sandbox.** The profile is allowlist-only in both directions: bubblewrap
  starts from an empty root and mounts the system base plus each phase's
  declared inputs read-only — the toolchain, the store, the warm workspace,
  and for Replay and Inspect the pristine checkout and the inspector. Only
  the per-job scratch is writable, all namespaces are unshared, and network
  is enabled only for the two phases that reach it — the initial clone of the
  author-supplied repository and Compile's pinned dependency fetch — so
  anything not declared, the database and other jobs included, is invisible to
  untrusted code. The clone runs sandboxed too, because the repository URL is
  author-controlled: it gets the tightest profile of all — only the job
  scratch mounted, no store — and ``git`` is confined to the https and file
  transports, so an ``ext::`` URL cannot execute a command and an
  ``ssh://``/``http://`` URL cannot forge a request. A local ``file://`` or
  path source (self-hosted archives) is mounted read-only so the sandboxed
  ``git`` can reach it; a production https source needs no mount. The
  toolchain is pre-installed at server start (elan's home is read-only inside
  the sandbox). This makes the server Linux-only; the CLI never sandboxes.

- **Trusted artifact store.** Everything Compile writes is suspect,
  including the dependency artifacts it fetched or built: code running
  inside the build can overwrite an upstream olean in place, and no replay
  can detect that (see Decisions). The server therefore never lets Replay
  or Inspect read a dependency artifact that Compile produced. It maintains
  a store of trusted artifacts with exactly two write paths: mathlib and
  core artifacts, fetched or built by the server itself against the archive
  pins; and the two packages of every submission, captured when its submit
  commits — draft or registration — right after its own Replay passed,
  which is precisely the moment those oleans are authenticated. The capture
  is exactly the inventory modules' oleans — the files Replay checked, so a
  forged extra module can never enter the store — copied, never linked,
  staged per job, promoted under the write lock; a re-draft overwrites it. Compile sees the
  store only through the seeded, read-only workspace (provisioned inputs,
  untrusted outputs); whatever it writes stays in the job scratch and is
  discarded when the job ends. Replay and Inspect then run with an
  explicitly composed search path whose dependency entries all point into
  the store, and whose only Compile-produced artifacts are the submission's
  own two packages — exactly the ones Replay checks. Concretely, the
  composed ``LEAN_PATH`` holds the submission's two lib dirs, the store
  dirs of the transitive, database-computed required submissions, and the
  warm workspace's mathlib dirs; core resolves through the toolchain
  sysroot. The store is complete
  by construction: Resolution admits only dependencies whose current triple
  the database confirms, and the submit that set that triple captured the
  artifacts. A downstream draft may race a re-draft of its dependency —
  harmless, drafts guarantee nothing; registration admits only immutable
  dependencies.

- **Processing.** The server is the single writer, so a global lock over
  database writes suffices. Writes are short: validate the request
  (ownership, state), commit the updated ``record.json`` (and
  ``build-output.json``), push. The expensive part of a submit — cloning the
  triple (itself sandboxed, since the repository URL is author-controlled) and
  running the full sandboxed build pipeline — happens *outside*
  the lock, so one submit does not stall unrelated requests. The ownership
  and state checks are therefore re-run after acquiring the lock: the record
  may have moved while the build ran, and a build against a stale record must
  not be committed.

- **Async submit.** The pipeline takes minutes, so ``POST /submit`` returns
  a job id which the CLI polls until it receives success or the violation
  report. Job ids are ephemeral: jobs live in server memory, a restart
  forgets them, and finished jobs are pruned after a retention window
  (currently one hour). Polling an unknown job yields 404, which the CLI
  surfaces as "resubmit" — a lost job never loses archive state, since the
  database commit is a submit's only durable effect.

- **Website.** After each push, the server runs the site generator and serves
  the result. Because the server is the writer, it never has to poll for
  changes: it knows exactly when the database moved.

## Distribution and Deployment

The CLI is the one component users install. We distribute via npm (package
``lax-archive``), making installs and updates one-liners; ``lax update``
runs ``npm install -g lax-archive@latest`` and then refreshes the database.

The CLI is not self-contained: it shells out to ``elan``/``lake`` (Compile;
building the inspector — Replay and Inspect invoke the pinned toolchain's
binaries directly), to
``git`` (the tracked-files check, ``lax submit``, and the database clone),
and to ``npm`` (``lax update``). The OAuth device flow is spoken directly to
github.com over HTTPS, so no GitHub CLI is required. It
checks for the tools a command needs on startup and names the missing one
rather than failing inside a subprocess. Installation clones the database (see Database Repository), which is
also the first ``lax pull-db``.

The CLI and the archive server are built from the same repository and share
the same pipeline phases; the server additionally makes Replay mandatory and
supplies trusted dependency artifacts. They likewise share the site generator
that ``lax serve`` runs and the one behind the website.

### Environment variables

All lax-specific configuration is environment variables; none is needed in
normal use.

CLI:

- ``LAX_HOME`` (default ``~/.lax``): the CLI's machine state — the database
  clone (``db/``), the warm mathlib workspace (``warm/``), and the compiled
  inspector cache (``tools/``).
- ``LAX_GITHUB_TOKEN``: GitHub token used instead of the ``lax login``
  token (CI, agents).
- ``LAX_SERVER_URL``, ``LAX_DB_URL``: override the baked-in archive API
  endpoint and database repository URL (defaults finalized at launch).

Server:

- ``LAX_SERVER_HOME`` (default ``~/.lax-server``): the server's state — the
  bare authoritative database repository, its working clone, the trusted
  store, and job scratch.
- ``LAX_SERVER_PORT`` (default 8080).
- ``LAX_SERVER_DB_URL``: the clone URL the server advertises for its
  database — in a deployment the public mirror (see DEPLOYMENT.md,
  "Database mirror"); defaults to the local bare repository.

Test seams, never set in production: ``LAX_MATHLIB_URL`` /
``LAX_MATHLIB_REV`` substitute a small fake mathlib so fast tests exercise
the real warm-store machinery; ``LAX_FAKE_GITHUB`` /
``LAX_FAKE_GITHUB_USERS`` substitute the GitHub token verifier. The
standard ``ELAN_HOME`` is respected wherever elan's home is consulted.


## Tests

A bunch of fast tests that should check all corner cases without mathlib,

and a single real e2e tests that does the full program!


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
