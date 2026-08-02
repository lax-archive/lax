# Lax

This document is the roadmap for Lax. The untagged sections describe the
minimal v0.1 archive; the version-tagged subsections describe the milestones
that grow it. It sits above [spec.md](spec.md), which remains the
fine-grained normative spec of whatever is currently implemented: where the
two disagree on detail, spec.md wins for the implemented slice, this
document for direction. The Milestones section at the end is the authority
on what lands in which version.


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

The v0.1 archive is an absolutely minimal version of this product.
Everything non-essential is postponed to a later milestone. At the same
time, we try to get those things right that cannot be easily changed later.


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
    - mathlib, pinned to revision ``c5ea00351c28e24afc9f0f84379aa41082b1188f``
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
  Each package **must** require mathlib — under the name ``mathlib`` from
  its canonical URL, pinned to the archive-wide revision — so the whole
  archive shares one mathlib closure; importing it remains the author's
  choice.
  Concept and proof packages of other submissions are added by pinning the
  full commit hash and subfolder of the submission's repository. Every such
  ``(git, rev, subDir)`` triple must resolve to a registered submission: a
  record with ``repository = git``, ``commit = rev``, and ``subDir`` equal
  to the record's ``folder`` joined with ``concepts`` or ``proofs``. Only
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

- **Root modules.** Each package has a root module: ``concepts/Lax261.lean`` in
  the concept package, ``proofs/Lax261Proofs.lean`` in the proof package. The
  build environment enforces that it contains all the modules of the package,
  and one ``import`` line per module, nothing else.

- **Empty submission.** A submission may contain no concepts and no proofs.

- **Pinned toolchain.** ``lean-toolchain`` must contain the archive-wide
  toolchain verbatim.

- **Builds.** Both packages must build: ``lake build`` succeeds in
  ``concepts/`` and in ``proofs/``. Lean warnings do not fail a submission.

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
    name = "mathlib"
    git = "https://github.com/leanprover-community/mathlib4"
    rev = "c5ea00351c28e24afc9f0f84379aa41082b1188f"

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
``assumptions``; anything beyond the subset is a build error, never a guess.
The recognized keys (the list may later be extended):

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


## v0.1 no security

In v0.1 the archive is open to a whitelist of contributors who all trust
each other. Building a submission runs the code of its dependencies, and
among whitelisted contributors that is fine: it is no different from
checking out a colleague's repository and running ``lake build``. No rule of
this section exists for security reasons yet.

## v0.2 concept security

Opening the archive to all users has two legs: this one protects the
machines of *users*, who compile strangers' concepts locally whenever they
build on them; the server's leg is v0.2 host security (see The Build
Pipeline).

**Guarantee.** Under a default ``lax build``, content from other submitters
is data, never code: parsed, elaborated, and reduced by the pinned trusted
toolchain, it acquires no capability of its own — no IO, no filesystem or
network access, no native code, no registered elaborators. This is needed
because Lean elaboration is code execution: a ``macro``, an ``initialize``
block, a ``#eval`` or ``native_decide`` all run author code on the machine
of whoever compiles — or merely imports — the module. The guarantee is a
confinement claim, not an absence-of-computation claim: foreign definitions
may cost time (a ``decide`` reduces them), never capability. Resource
exhaustion is an accepted non-goal.

**How.** Concept packages must be written in a whitelisted subset of Lean —
the **concept dialect** — that admits no construct able to register or
embed author code; the whitelist is a versioned, machine-readable schema,
and everything outside it fails closed. Proof packages stay unrestricted
(they are written largely by AI agents wielding heavy tactics and
metaprogramming), and are covered by refusal instead: a default local build
never compiles a stranger's proof package, and overriding that requires an
explicit consent flag.

**Enforcement** is server-side: a gate checks the dialect on every submit,
before Compile, and records a passing verdict on the submission's record;
dependency resolution admits only submissions with a valid verdict. Users
need no local checker — they inherit the server's verdict through the
database.

## v0.2 sibling path requires

**Problem.** Dependencies between submissions are pinned ``(git, rev,
subDir)`` triples, and ``lax submit`` derives a submission's own triple
from HEAD. For interdependent submissions in one repository this makes
every wave of edits a hand-run ceremony: a dependent's pin can only be
written *after* the dependency's submit lands (the commit hash does not
exist before), so n submissions cost n sequential commit–submit–repin
rounds in topological order, and every re-draft of an upstream stales
every downstream pin even when the downstream is untouched. The
immutability being enforced buys nothing here — it is a draft-time
phenomenon, and drafts guarantee nothing.

**Rule.** The ``../concepts`` exception generalizes: a ``[[require]]``
may name a sibling submission of the same repository by relative path —
keys ``name`` and ``path`` only, e.g. ``path = "../../othersub/concepts"``.
The package-kind constraints carry over verbatim (concept packages may
path-require only concept packages; proof packages also proof packages,
with the same warning), and ``name`` must equal the target package's
fixed name. The dependency this expresses is "that folder of *this
repository at this commit*". Both ends are frozen by the one containing
commit — the same argument that already admits ``../concepts`` — so a
path edge between two submissions registered at the same commit is
exactly as immutable as a pinned triple. Pinning by triple remains
available, including into one's own repository: "the same folder at an
*older* commit" is deliberately not expressible as a path.

**Resolution.** The path is normalized purely lexically against the
requiring package's folder; it must stay inside the repository, traverse
no symlink, and equal another submission folder's ``folder`` joined with
``concepts`` or ``proofs``, at the same commit. The ``manifest.yaml`` at
the target folder names the record the edge points at. The edge is
admitted when the target is either (a) a member of the same submit batch
(below), or (b) a record whose current source triple is exactly (this
repository, this commit, that folder) — nothing else, in particular no
"same folder, other commit" and no "same content, other commit". The
local pipeline checks path edges structurally (target exists, manifest
id, package kind, no cycle); the record half of the rule is a submit-time
check, because only the submit knows the batch.

**Batch submit.** ``lax submit`` accepts several folders of one
repository at one commit and hands the archive one batch. The acting
account must be in the owner set of every member. The server orders the
members along their path edges and runs each member's pipeline
bottom-up; sibling packages resolve inside the same clone, so members
need no provisioning beyond the warm store, and each member's fresh
artifacts seed the next. The database write is atomic: one commit to the
database repository moves all member records, or a failing member fails
the whole batch — no half-submitted waves. With ``--register`` the batch
registers bottom-up under the same atomicity, and "registration admits
only registered dependencies" generalizes to "registered, or a member of
the same batch". A wave of interdependent submissions is thereby one
commit, one command, zero repins — which also retires the main reason
draft-on-draft triple pins existed.

**Acyclicity.** Path edges make dependency cycles between packages
expressible for the first time (triples cannot close a cycle: the hash
of a commit cannot occur inside it). Within a batch, the member graph
must be acyclic — a cycle is a violation, reported in Resolution. Across
submits no check is needed: rule (b) only admits targets whose record
already sits at this very commit, and that record's own edges were
validated under the same rule at its earlier submit, so a cycle can
never close by induction. The proof network's least-fixed-point
semantics are untouched either way.

**Edge cases, decided.**

- Two folders of one commit carrying the same manifest ``id``: violation
  at Resolution, whether or not both are in the batch.
- A path that normalizes into the requiring submission's own folder:
  violation; the self-reference keeps its dedicated ``../concepts``
  spelling, and a proof package never path-requires its own concepts any
  other way.
- Submission folders in one repository must be disjoint — no submission
  folder nested inside another. This was always implicit; path targets
  make it load-bearing, so the pipeline now checks it.
- Members may freely mix path edges and triples; only the
  path-connected members of a repository must move through a submit
  together. Unconnected siblings keep independent lifecycles.
- A single-folder submit at a new commit whose path edge targets an
  unmoved sibling fails rule (b). The fix is spelled "list both folders
  in one ``lax submit``", not a repin.
- A later re-draft of one member alone leaves co-members' records
  pointing at the older commit. This is the existing draft race the spec
  already calls harmless, and it cannot happen to registered members:
  their triples are frozen at the shared commit forever.
- Registering only part of a wave from a commit is allowed bottom-up:
  the registered members then satisfy rule (b) for a later registering
  batch from the *same* commit. From any newer commit, registered
  siblings are reachable by triple only.

**Cost.** Path-connected members re-submit together, so an unchanged
upstream is re-run by the server on every wave; the warm store keeps
that cheap. In exchange the ripple, the repin commits, and the
hand-maintained submit runbooks disappear, and the records of a wave
always agree on one commit — no version skew between co-dependent
drafts on the website.

## v0.4 atoms

**Output.** Concepts are decomposed into **atoms** — individual
declarations, each with its own signature and description — and the website
renders each concept as a DAG of its atoms. The DAG is heuristic: it comes
with no locality guarantees (see v0.? locality), but it gives reviewers a
navigable structure for long concepts, which is the point — today the
concept must be read as one block.

**Implementation.** This is known to be hard: the built environment does not
record which source command introduced a declaration (``abbrev``,
``instance`` and ``def`` are indistinguishable, ``example`` leaves no
trace), so atoms need either a source walk matched against the environment
or an observer running inside the build. ``build-output.json`` is derived
data, so retrofitting a per-declaration layer later breaks no citation and
no stored record — which is why deferring this is safe.

## v0.? locality

**Goal.** A DAG between the atoms of a concept with a **locality**
guarantee: the meaning of an atom is fully determined by its own cone in
the DAG, so a reviewer can trust their reading of an atom after reading
only its ancestors, not the whole concept and everything it imports. This
would be the strongest reviewing aid the archive could offer.

**Implementation.** Unknown. Locality is a semantic property of elaboration
and we do not currently know how to certify it; we expect to need help from
someone who knows the elaborator deeply. Deferred to an undefined time —
possibly a lighter, best-effort version (locality checked, not guaranteed)
can come earlier.


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


# The Build Pipeline

The build pipeline checks a submission against the Submission Layout rules
and derives its ``build-output.json``. It is the sole authority on what
those rules mean. It operates directly on the submission folder — the two
packages are the only workspaces — and it is the same pipeline locally
(``lax build``) and on the server (gating every submit).

The pipeline runs in phases. Violations are collected, not failed fast, so
the final report lists every violated rule; a phase with violations aborts
the subsequent phases.

- **Static validation** (milliseconds, no network): folder layout, license,
  ``abstract.md``, manifest schema, ``lean-toolchain``, the lakefile
  whitelist of the Packages section, and that no generated file is tracked
  by git. This phase also derives each package's **module inventory** — the
  root module plus one module per ``.lean`` file, read off the file paths
  via Lake's canonical mapping. The inventory is the pipeline's sole answer
  to "which modules does this package contain"; later phases never
  rediscover it from build artifacts.

- **Resolution** (milliseconds, no network): check that every dependency
  triple resolves to a registered submission — against ``~/.lax/db``
  locally, against the local checkout on the server. A local miss may just
  mean a stale database, so the CLI suggests ``lax pull-db`` and a retry
  before reporting the violation.

- **Compile:** ``lake build`` in ``concepts/`` first, then in ``proofs/``
  (skipped when the concepts build fails). Compile is the pipeline's only
  networked phase: it fetches the pinned git dependencies and, on a fresh
  machine, the pinned toolchain via ``elan``. A failing build is a
  violation; the build transcript is reprinted so the author can act on it.

- **Inspect:** extract environment facts with the ``Lax.Inspector``
  executable, then judge every remaining rule in the CLI: the import rule,
  root-module exactness, axiom sets, namespaces, annotations, and the proof
  checks (conclusion resolution, defeq, theorem kind).

- **Emit:** write ``build-output.json`` into the root of the submission.

Two principles govern Inspect, spelled out fully in spec.md. First, the
inspector never runs author code: it is a standalone executable importing
only Lean core, and it loads the packages' oleans with initializer
execution switched off. (Running an inspection command inside the
workspace instead would be fatal: merely importing a module executes its
``initialize`` blocks, and once author code runs inside the inspecting
process, nothing that process reports can be trusted.) Second, the
inspector decides nothing: it only reports facts, and the CLI — which
alone knows the archive's rules — decides what counts as a violation. A
consequence worth stating: the pipeline never parses Lean source. Every
unit it judges is something the built environment knows — a concept is a
module, a statement is an axiom, theorem-ness is the kernel's kind,
annotations are persisted docstrings — and ``sourceText`` is a verbatim
copy of the file, not a parse.

## Caching

Normal-sized submissions must build in under three minutes, locally and on
the server (the budget is a v0.1 milestone requirement). That requires
never rebuilding mathlib or previously built submissions.

The mechanism is a **warm store** of prebuilt artifacts at the archive
pins: mathlib and toolchain prebuilt once per machine, plus the oleans of
already-built submissions. The server seeds every job workspace from the
store; the local CLI keeps its own copy under ``~/.lax/``. Because the
whole archive shares one pinned mathlib closure (the mandatory require),
one warm mathlib serves every submission. To keep builds resolution-free,
``lake-manifest.json`` is generated by lax from the lakefile plus the
archive pins — authors never run ``lake update`` — and Lake's own artifact
cache is disabled in favor of the store. Warm, a mathlib-importing
submission's server pipeline runs in well under a minute; the remaining
floor is loading the mathlib environment, not building anything.

## v0.1 no security guarantees

Contributors are whitelisted and trust each other (see Submission Layout,
v0.1), so the server may run the pipeline without a sandbox. But security
is hard to bolt on later, so we may build v0.1 with the host-security
mechanisms below already in place — just without red-teaming and without
claiming any guarantee yet.

## v0.2 host security

Required (together with concept security) before opening up to all users:
strangers' proof packages are unrestricted Lean and run on our server.

**Guarantees.** The server cannot be compromised, and the code the website
displays is the code that was checked. The website's *claims* remain as
honest as its submitters — that gap is closed in v0.3.

    author ──── lax submit (repository, commit, folder) ────▶ archive server
                                                                    │ job
        ┌────────────── bubblewrap sandbox ────────────────┐        │
        │  empty root + declared read-only inputs          │ ◀──────┘
        │                                                  │
        │   clone author repo    [network on, scratch rw]  │
        │        ▼                                         │
        │   dialect gate (v0.2 concept security)           │
        │        ▼                                         │
        │   compile on a copy    [warm store read-only]    │
        │        ▼                                         │
        │   own oleans + committed sourceText              │
        └────────────────────────┬─────────────────────────┘
                                 │ extracted by the server
                                 ▼
              record.json + build-output.json ──▶ database repo ──▶ website

**How we do it.** Everything that runs author code or loads author-built
artifacts runs inside a bubblewrap sandbox built up from an empty
filesystem: a job sees only what we explicitly mount — declared read-only
inputs plus one writable scratch folder — and gets network access only in
the phases that need it.

- Even the ``git clone`` of the author's repository runs sandboxed: the
  URL is attacker-controlled (SSRF, ``ext::`` transports).
- The dialect gate of v0.2 concept security runs sandboxed too, before
  Compile; host security is what makes its verdicts trustworthy.
- Compile works on a copy of the checkout, and only the submission's own
  oleans are taken out. The ``sourceText`` shown on the website comes from
  the untouched checkout, so it is really the code that was checked.
- The shared warm cache (prebuilt mathlib) is mounted read-only, so no job
  can tamper with what later jobs read.

## v0.3 replay proof security

Here we implement the replay mechanism and lay out the full trust
pipeline. This tier builds strictly on v0.2 host security: the trusted
store below is only sound because the sandbox confines what untrusted code
can write.

**Guarantees.** The proof network, as displayed on the website, is correct
— secure against bad actors, not just honest mistakes.

**How we do it.** The server keeps a **trusted store** of oleans it built
or checked itself: mathlib, built once at the archive pins, plus the
oleans of every registered submission, captured right after that
submission's own check passed. A submit then does three things:

- For the dependencies — mathlib and previous submissions — use the
  trusted oleans from the store; whatever Compile fetched or built for
  them is discarded. This is the only sound option: no check can
  authenticate an import, because a forged upstream axiom is exactly as
  kernel-valid as the real one. Dependencies are trusted by where they
  come from, not by being checked again.

- For the submission itself, take the oleans Compile produced and re-check
  every declaration in them with ``leanchecker`` (the kernel checker
  shipped inside the pinned toolchain) against the trusted dependency
  oleans. This is the new **Replay** phase between Compile and Inspect. It
  exists because Compile runs arbitrary author code, which can write
  oleans containing declarations the kernel never checked. The list of
  modules to replay comes from Static validation's file-derived inventory,
  never from anything Compile wrote — otherwise the attacker who wrote the
  artifacts would choose what gets checked.

- Finally, check that what the submission claims about its dependencies is
  really in the trusted oleans: Inspect verifies that every axiom a proof
  uses is defeq to the registered concept statement it names.

On success the submission's now-replayed oleans enter the trusted store
and become the dependencies of future submits. The edge cases live in
spec.md (The Build Pipeline).

## v0.3 composition proof security

An alternative proof-security mechanism that certifies unconditionally
proven statements directly.

**Guarantees.** When the website displays a statement as proven, it is
actually proven — secure against bad actors.

**How we do it.** Instead of trusting stored proof artifacts, assemble
the entire proof of a statement and check it once:

- Build the full proof term: start from the proof that concludes the
  statement, and recursively replace every statement axiom it assumes by
  the proof discharging that statement. The definition of "proven" as a
  least fixed point guarantees there are no cycles, so the substitution
  terminates; the archive-wide pins guarantee all the pieces fit into one
  coherent environment.
- Hand the assembled term to a short, few-line checker: it must prove the
  target statement from background axioms only, sorry-free. A forged or
  broken proof anywhere in the chain simply fails the kernel — nothing
  needs to be trusted except the kernel itself.
- One thing must still be authentic: the *target*. What gets certified is
  "this term proves this type", and that type must be the one captured at
  the concept's own submit — before any unrestricted code could touch it —
  never one supplied by a later build. That is exactly what the v0.2 tiers
  provide (host security's compile-on-copy, concept security), so
  composition builds on them.

If this proves viable, host security + concept security + composition is
the simplest total path to trustworthy "proven" marks. The trade-off:
only "proven" verdicts are certified — axiom displays, signatures, and
draft facts stay submitter-honest.


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
not reviewable, and not allowed to be used in downstream submissions.

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

- The **build pipeline** checks a submission against the archive's rules
  and derives its ``build-output.json`` (see The Build Pipeline).

- The **site generator** turns the database into the website.

- The **database repository** holds the archive's state.

- The **CLI** ``lax`` is the only thing authors and agents ever touch.

- The **archive server** is the archive's single piece of infrastructure. It
  serves a small HTTPS API to the CLI, runs build pipeline and site generator
  centrally, and is the sole writer of the database repository.

## Site Generator

The site generator is a static site builder: it reads the ``record.json``
and ``build-output.json`` of the database and emits the pages described
under Website (see The Social Layer / Website).

## Database Repository

The folder tree of the Archive Database section is the canonical state of the
archive; everything else (website, indexes) is derived. The database is a
single public git repository with a single writer — the archive server — and
every user holds a read-only clone of it at ``~/.lax/db``. The path is
deliberately visible, so AI agents can use it to survey existing submissions
and find prior work to build upon. Installing the CLI clones the repository.

## CLI

The acting GitHub account authenticates via GitHub OAuth (the CLI reuses an
existing ``gh`` login). ``lax`` has the following commands:

**lax init [folder]** (default ``.``) starts a submission, see Actions. The
folder must be empty or not yet exist; otherwise init refuses. The scaffold
comprises ``manifest.yaml`` (with ``id: LaxN`` and the environment pins),
package folders, lakefiles, ``lean-toolchain``, root modules, ``abstract.md``,
``LICENSE``, and a ``.gitignore`` covering ``build-output.json``,
``lake-manifest.json``, and ``.lake/``. Init warns when the folder is not
inside a git repository. The result passes ``lax build`` as an empty
submission.

**lax set-owners [folder] --new-list <handle>...** (default ``.``) replaces
the owner set with the given GitHub handles (resolved to numeric account ids,
see Archive Database), see Actions. The submission is identified by the ``id``
in the folder's ``manifest.yaml``.

**lax build [folder]** runs the build pipeline: it checks the submission
against the archive's rules and on success writes ``build-output.json``. Any
violation fails with a nonzero exit and a report listing every violated rule.

**lax serve [folder]** runs the **site generator** and serves the result
locally. It is a long-running process that does not daemonize by default. It
watches both the local database and the submission folder for changes: the
submission's ``build-output.json``, and the ``record.json`` of registered
submissions. Every change triggers a website rebuild. The local folder is
rendered from its own ``build-output.json`` against a synthetic draft record,
so ``lax serve`` works before ``lax init`` has allocated an id. If
``build-output.json`` is missing, the website shows a placeholder stating that
the output has not been generated yet; ``lax serve`` does not build.

**lax submit [folder]** derives the (repository, commit, folder) triple from
the folder's git state — the remote URL, the HEAD commit, the folder's path
within the repository — and hands it to the archive. It refuses if the
worktree is dirty or HEAD is not present on the remote. Without
``--register`` it requests the draft state, with it registration; on success
the archive updates the record as described in Lifecycle.

**lax pull-db** refreshes the local database checkout at ``~/.lax/db``, see
Database Repository. It is read-only with respect to the archive and needs no authentication.

**lax update** upgrades the CLI itself to the latest release and then refreshes
the local database, see Distribution. Likewise needs no authentication.

**lax spec** prints this specification. The text is embedded in the binary at
build time, so the printed spec is exactly the one that binary enforces.
Useful for agents authoring submissions.

## Archive Server

One server does everything the archive does centrally: it answers the CLI's
write requests, owns the database repository, and puts the website online.

- **Authentication.** The CLI sends the user's GitHub OAuth token (reused
  from the ``gh`` login) with every write request. The server verifies the
  token against GitHub and resolves it to the numeric account id that all
  ownership checks run against.

- **Endpoints.** One per write action: ``POST /init``, ``POST /set-owners``,
  ``POST /submit`` (with a ``register`` flag), plus ``GET /jobs/<id>`` for
  polling a submit (see Async submit). These three write commands are the only
  ones that leave the user's machine. Reading *archive content* needs no server
  at all — it goes through the public database repository (``lax pull-db``);
  the server answers no content queries.

- **Build Pipeline.** Every submit runs the full pipeline centrally; its
  security tiers — what runs sandboxed, how dependency artifacts are
  provisioned — are described in The Build Pipeline.

- **Processing.** The server is the single writer, so a global lock over
  database writes suffices. Writes are short: validate the request
  (ownership, state), commit the updated ``record.json`` (and
  ``build-output.json``), push. The expensive part of a submit — cloning the
  triple and running the full build pipeline — happens *outside* the lock,
  so one submit does not stall unrelated requests. The ownership
  and state checks are therefore re-run after acquiring the lock: the record
  may have moved while the build ran, and a build against a stale record must
  not be committed.

- **Async submit.** The pipeline takes minutes, so ``POST /submit`` returns
  a job id which the CLI polls until it receives success or the violation
  report.

- **Website.** After each push, the server runs the site generator and serves
  the result. Because the server is the writer, it never has to poll for
  changes: it knows exactly when the database moved.


# The Social Layer / Website

## Website

The website is the archive's public face, generated statically from the
database. One page per submission — abstract, authors, bib entries, and its
concepts with title, description, Lean source, and statement signatures —
and one page per concept. Index pages list submissions and let visitors
browse the concept DAG and the proof network, marking each statement proven
or unproven. Drafts are shown and marked as such. The website is public
from day one; only writing to the archive is ever restricted.

The website looks production ready from day one, so that users can anticipate
where we are heading. The only thing not implemented is the following social
layer.

### unordered ideas how we implement the website

#### extending build-output.json

first, we rewrite the annotation rules so that additional markdown-keys are given by top-level headings. this should make it more ergonomic

    ---
        title: ramseys theorem
        type: Theorem
    ---
    # description
    the description here
    # review notes
    introduces an additional key "review notes" with this string as value

This is optional, and the lack of #-headlines parses everything still into the description key. so fully backwards compatible.

next, we also introduce a "type" field where concept authors have to annotate if their concept is a "definition" "theorem" "lemma" or whatever. we accept arbitrary strings here.

#### website (THE BIG TODO TO IMPLEMENT THIS SESSION!)

start with the design of my earlier concept website
https://main.autoformalize.pages.dev/
sidebar and everything stays.

changes/additions we make
- we use markdown instead of latex for rendering. this means we need another mechanism than \Cref{id} to create references. pick your favorite
- instead of Verification✓, we write a more descriptive text. make some suggestions. maybe different for those things with and without statements?
- we dont include the "main results" thing
- we show author, date, draft state, etc in some sleak way. not just an ugly table copying the manifest and record.json
- but instead show the abstract first.
- all submissions, even drafts, are citable (with copyable citation the end of page)
- like concept page, show the type via a 3letter shortcut. for known things like theorem, we shorten to thm.
  other unkown things are just hte first three letters. no special colors needed.
- careful with the times modern rendering and the math! the constants need to be tweaked just as in the draft page to display in the same font size.

#### graphs
- instead of cramming statement and proof deps into one graph, we have two different figures. they use the same d3 rendering as the concept website
- show concept dependencies as a layered dag. those without dependencies at the bottom. make nodes wide enough to carry a usual-length id.
- show proof network via spring layout? again, nodes wide enought to carry a usual-length id (rest capped with ...) and nodes dont overlap so ids stay readable.
- gray out nodes outside the current submission?





## v0.3 The Social Layer: Reviewers, Endorsements and Flags

The social layer arrives together with proof security: endorsements are
staked on what the website displays, so the display should be trustworthy
first.

A **reviewer** is a verified ORCID identity (via OAuth) with a real-world name,
leading to trust by reputation. Reviewers act on the social layer.

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



# Distribution and Deployment

The CLI is the one component users install. We distribute via npm or
similar, making installs and updates one-liners, and expose the upgrade as
``lax update`` so no user has to know which package manager we chose. The
CLI is not self-contained: it shells out to ``elan``/``lake``, to ``git``,
and to ``gh``; it checks for all three on startup and names the missing one
rather than failing inside a subprocess. Installation clones the database.

Deployment is the least-explored part of this plan — there may be more
clever cloud-native setups — but for now we deliberately keep it simple:

- a **single VM** running a single server process that contains the API,
  the build pipeline, and the site generator; jobs run iteratively, no
  parallelism;
- the server is kept **warm**: prebuilt mathlib and the oleans of previous
  submissions are available to every job (see The Build Pipeline, Caching);
- **persistent state** is the database git repository, plus a small store
  for the whitelisted users — later also for ORCID identities and
  endorsements.

The CLI and the archive server are built from the same repository, which
keeps the pipeline authors run locally and the pipeline that gates
registration the same build — and likewise the site generator behind ``lax
serve`` and the one behind the website.

## v0.1 invite only

The write service is only available to GitHub users on a whitelist. The
website is available to anyone.

## v0.2 fully available

The service is available to anybody; no rate limits or moderation required
yet. Prerequisite: both v0.2 security tiers (concept security for user
machines, host security for the server). Known and accepted limitation:
until v0.3 proof security, "proven" on the website rests on submitter
honesty.


# Milestones

This section is the authority on what lands in which version; each item
names the section that describes it.

**v0.1 — invite only.**
- Everything in the untagged sections of this document.
- A rigorous edge-case and e2e test suite.
- Building or submitting a regular-sized submission takes at most 3 minutes
  (The Build Pipeline, Caching).
- Live to our friends; advertise it among people we know or who we think
  would care about this type of stuff.
- Create our own flagship submissions that show off how to create idiomatic
  concepts.

**v0.2 — open.**
- Incorporate feedback from the v0.1 test users.
- Concept security (Submission Layout) and host security (The Build
  Pipeline) — together the prerequisite for opening up.
- Sibling path requires and batch submit: interdependent submissions of
  one repository submit and register as one wave from one commit
  (Submission Layout).
- Fully available (Distribution and Deployment).
- Go live, do community outreach.

**v0.3 — open, trustable and social.**
- Proof security — replay-based or composition-based or both, decide by
  then (The Build Pipeline) — upgrading "proven" from submitter-honest to
  certified.
- The social layer: ORCID reviewers, endorsements, flags (The Social
  Layer / Website).

**v0.4 — open, trustable, social and pretty.**
- Atoms (Submission Layout).
- General cleanup.

**v0.? — locality.**
- The locality DAG (Submission Layout) — unscheduled, pending a workable
  design.
