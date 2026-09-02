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
- pinned Lean toolchain: ``leanprover/lean4:v4.30.0`` (the exact content of
  every ``lean-toolchain`` file, followed by one newline; it also fixes Lake)
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
- trusted validation sandbox
    - stock image ``node:22-bookworm-slim@sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066``
      with the pinned host toolchain and warm mathlib workspace mounted
      read-only
- allowed background axioms
    - ``propext``
    - ``Classical.choice``
    - ``Quot.sound``


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

Additional Rules:

- **License.** The file ``LICENSE`` in the submission root folder must contain
  an accepted license, matched against the canonical text after whitespace
  normalization. One optional final line of the form ``Copyright YYYY[-YYYY]
  NAME`` is ignored. For the MVP we accept exactly one license: the **Apache
  License 2.0**, the license of Lean and mathlib.

- **Abstract.** ``abstract.md`` must be non-empty. It is rendered as markdown,
  with inline math delimited by ``$...$`` or ``\(...\)``, and shown prominently
  on the website.

- **Files.** ``build-output.json``, ``lake-manifest.json``, ``.lake/``, and
  Lake package-overrides files must not be checked in. Generated files left by
  a local build are fine. Extra root-level documentation is allowed but is not
  submission content; undeclared files inside either package are rejected.

- **Limits.** A repository may contain at most 100,000 regular files totalling
  2 GiB and no symlinks or special files. ``manifest.yaml``, ``LICENSE``, and
  each lakefile are limited to 256 KiB, ``abstract.md`` to 1 MiB, and
  ``lean-toolchain`` to 1 KiB. Titles have at most 200 Unicode characters and
  512 UTF-8 bytes; manifests have at most 100 authors and 1,000 bibliography
  strings of 16 KiB each; each package has at most 200 requirements. Displayed
  concept source files are limited to 4 MiB.

## manifest.yaml

The file ``manifest.yaml`` must contain the following keys and adhere to the
following rules.

- ``specVersion``: version of the spec this submission adheres to
- ``mathlibVersion``: version the submission was built against
- ``leanVersion``: version the submission was built against

- ``id``: The archive-assigned unique id. Its canonical form is ``lax-N`` for
  a positive natural number N written without leading zeros; the legacy
  spelling ``LaxN`` is accepted and normalized. Ids are deliberately opaque;
  this prevents the squatting of nice names like ``RamseyTheory``.

- ``title``: A non-unique title, like the title of the paper the submission formalizes.

- ``authors``: An ordered, possibly empty, list of author entries. Each entry is a
  tuple with a required ``name`` (display name) and optional ``orcid`` and
  ``github`` identifiers. Used for credit only, not rights-management.

- ``bibEntries``: a possibly empty list of strings. Each string contains one
  or more structurally complete BibTeX entries, as in a ``.bib`` file.

Additional Rules:
- ``specVersion``, ``leanVersion``, ``mathlibVersion``: must match the
  archive environment for now. ``leanVersion`` holds the version tag
  (``v4.30.0``); the full toolchain name (``leanprover/lean4:v4.30.0``)
  appears only in the ``lean-toolchain`` files.
- All scalar manifest fields are YAML strings, not numbers or other scalar
  types.
- No keys beyond the ones listed here are allowed.

Example:

    specVersion: "1"
    id: lax-261
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

- **Dependencies.** Besides mathlib, concept packages may require only
  concept packages; proof packages may require both concept and proof
  packages. We issue a warning whenever a proof package is required.
  A proof package need not depend on its own concept package; it may prove
  only conjectures from unrelated submissions.
  Each package **must** require mathlib — under the name ``mathlib``
  from its canonical URL, pinned to the archive-wide revision.
  Concept and proof packages of other submissions are added by pinning the
  full lowercase 40-character commit SHA and subfolder of the submission's
  repository. Every such
  require resolves by name: by the fixed-names rule the require name is the
  required submission's package name and thereby names a record in the
  database (which keeps two submissions at different folders of one commit
  apart). The require's ``(git, rev, subDir)`` must equal that record's
  current source — ``repository``, ``commit``, and ``folder`` joined with
  ``concepts`` or ``proofs`` — verbatim: write the canonical ``repository``
  spelling (see ``lax submit``), not an ssh alias of it. A draft dependency
  is admitted with a warning; registration admits only registered
  dependencies (see Lifecycle). Cross-submission path requirements are not
  supported: multi-submission work is committed and submitted bottom-up, with
  each dependent pinning the preceding submission's exact Git commit. The
  only path exception is the proof package's own concept package via
  ``../concepts``. The transitive Archive dependency graph must be acyclic.

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
  comment, a stray ``#check``) is tolerated. One caveat on "exactly": a Lean
  module without imports implicitly imports ``Init``, so the root module of an empty
  package records that single import, which the check ignores.

- **Empty submission.** A submission may contain no concepts and no proofs.

- **Pinned toolchain.** ``lean-toolchain`` contains exactly the archive-wide
  toolchain followed by one newline.

- **Builds.** Both packages must build: ``lake build`` succeeds in
  ``concepts/`` and in ``proofs/``. Lean warnings do not fail a submission.

- **The manifest is derived.** ``lake-manifest.json`` is a lax-generated
  file, like ``build-output.json``. ``lax init`` seeds both packages from the
  pinned warm mathlib workspace, and ``lax build`` refreshes the manifests
  from the validated dependency closure (see Build Pipeline, Provision). They
  are never authored or committed. Authors do not run ``lake update``; plain
  ``lake build`` follows the generated manifest.

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
ordinary docstrings. Recognized frontmatter is validated strictly — an
unrecognized key, missing ``conclusion``, or declaration of the wrong kind is
a build error — and a docstring containing an unrecognized ``---`` attempt
produces a warning.

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

We annotate concepts and proofs. A concept is annotated by exactly one module
docstring ``/-! … -/``. A proof is annotated by the usual docstring
``/-- … -/``.

Each annotation is a docstring that we parse as markdown with yaml frontmatter
(a common pattern from static site generators). The markdown after the
frontmatter is the description. Top-level ``#`` headings split out named
sections; a section titled ``Description`` supplies the description when
present. Inline math may use ``$...$`` or ``\(...\)`` delimiters. The frontmatter
grammar is a fixed minimal subset of yaml — scalar ``key: value`` lines, plus
a plain list of names for ``assumptions`` — because it is parsed by the
inspector in core-only Lean (see Inspection Scaffolding); anything beyond the
subset is a build error, never a guess. The recognized keys are:

Concept
    - ``title`` (required): natural-language name of the mathematical object,
      like "Ramsey's Theorem"
    - ``type`` (required): a free-form label such as "theorem" or "definition"

Proof
    - ``conclusion`` (required)
    - ``assumptions`` (optional): a yaml list of fully qualified statement
      names, see Proofs

The Markdown body is required for concepts and optional for proofs. The whole
validity of the archive rests on the assumption that the Lean side of a
concept faithfully represents this natural-language description.

Frontmatter with an unrecognized key leads to build errors.

An example concept module ``concepts/Lax261/Myconcept.lean``:

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

The archive stores one folder per allocated id. Every ``lax-N/`` folder
contains exactly three files: ``record.json``, ``build-output.json``, and
``owner-list.json``. They separate lifecycle and source state, validated
content, and authorization so each action changes only the files it owns.

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
draft and become immutable on registration.

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
        "leanToolchain": "leanprover/lean4:v4.30.0",
        "mathlibCommit": "c5ea00351c28e24afc9f0f84379aa41082b1188f",
        "files": [ ... ],
        "registryBlob": "ghcr.io/lax-archive/lax-captures@sha256:..."
      }
    }

- ``issue`` binds the database folder to its one authoritative issue by
  immutable repository id and issue number. Init and deleted records retain a
  stub ``build-output.json`` containing only ``specVersion``, ``id``, and this
  binding.
- ``inputs.manifest`` is the parsed ``manifest.yaml`` and
  ``inputs.abstract`` is its UTF-8 text with line endings normalized to LF, so
  the website needs no repository access.
- ``requiredByConcepts`` lists Archive packages directly required by the
  concept package, and ``requiredByProofs`` lists those directly required by
  proofs. Pinned mathlib and the proof package's own concept path are omitted.
- ``capture`` authenticates the declared Lake and Lean package inputs,
  generated manifests, and Lake build artifacts produced by trusted
  validation. Consumers fetch its OCI blob from GHCR by the recorded digest
  and verify the archive digest and per-file hashes; mutable tags are only for
  discoverability.

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
          "signature": "X : ..."
        }
      ]
    }

``title``, ``type``, ``description``, and optional ``sections`` come from the
concept annotation. ``imports`` lists directly imported archive modules and
``mathlibImports`` lists directly imported mathlib modules. ``sourceText`` is
the UTF-8 file content with line endings normalized to LF. ``statements`` lists any
number of concept axioms with their pretty-printed types and, where available,
source ranges and docstrings; the website marks each proven or unproven.

Each entry of ``proofs``:

    {
      "id": "Lax261Proofs.Q",
      "path": "proofs/Lax261Proofs/Basic.lean",
      "conclusion": "Lax261.Myconcept.X",
      "assumptions": ["Lax42.Colorings.Somestatement"],
      "description": "...",
      "sections": [{ "title": "Strategy", "markdown": "..." }]
    }

``assumptions`` is always the pipeline-computed set, regardless of whether the
author supplied the redundant ``assumptions`` key. Proof entries carry no
``sourceText``: the website lists proofs, it does not display their code.

The content-bearing file is deterministic: concepts, statements, and proofs
are sorted by ``id``; package names, imports, assumptions, capture files, and
other set-like lists are sorted lexicographically. Annotation sections retain
authorial order.


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
not reviewable. Usable as a dependency only by other drafts: registration
requires registered dependencies. A re-draft moves the record's source
triple, so downstream drafts fail resolution until they update their pin.

**registered:** immutable, citable, reviewable. The normal published state.

**deleted:** a permanent tombstone. The id, issue binding, owner list, and
timestamps remain, while source and validated content are removed. Deleted ids
are never reused.

The only state transitions are:

- ``-> init``
- ``init or draft -> draft``
- ``init or draft -> registered``
- ``init or draft -> deleted``

Registered and deleted records are immutable.

## Actions

Every archive action is initiated through the CLI, which creates the
authoritative GitHub issue or posts a fixed ``/lax`` command to it. GitHub
Actions validates and publishes the resulting database change.

**Init.** ``lax init`` takes an empty local folder and opens an ordinary issue
in ``lax-archive/lax``. Its issue number allocates ``lax-N`` and the workflow
creates the three init stubs whose owner list contains the authenticated issue
author. The CLI then scaffolds the complete submission layout (see CLI).

**Owners.** ``lax owners`` posts ``/lax owners <JSON>`` to replace the owner
list of an init or draft submission. The actor must be a current owner and
must remain in the replacement list. Numeric GitHub account ids are resolved
again before publication.

**Submit.** ``lax submit`` posts a (repository, commit, folder)
triple. The folder must contain a complete valid manifest whose ``id`` equals
the id of the record being submitted to. That record must be in the init or
draft state, and the authenticated GitHub account must occur in its stored
owner set.

- A successful submit puts the submission in the draft state and replaces its
  source triple and validated content. Trusted validation always rebuilds the
  immutable commit; it never trusts the author's local ``build-output.json``.

**Register.** ``lax register`` posts ``/lax register`` and freezes an init or
draft record without rebuilding it. Every Archive dependency recorded in its
current build output must already be registered.

**Delete.** ``lax delete`` posts ``/lax delete`` and permanently replaces an
init or draft record with a tombstone. Registration and deletion are separate,
irreversible actions and require explicit confirmation in the CLI.





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
an environment notion — a statement is an axiom, theorem-ness is the
kernel's kind, docstrings are persisted data — and why rules that only the
surface syntax could decide were dropped. The generated
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

The trusted pipeline fetches the submitted public Git commit from a supported
host and a pinned
Archive snapshot into an ephemeral GitHub-hosted runner. It copies that
checkout into fresh workspaces for compilation and derives all dependency
inputs from the validated lakefiles and Archive records. The local authoring
pipeline instead builds in place so ``.lake`` persists across runs.

It runs multiple phases. Violations are collected, not failed fast, so the final
report lists every violated rule. A phase with violations aborts the
subsequent phases.

- **Static validation** (milliseconds): folder layout, file limits, license,
  ``abstract.md``, manifest schema, ``lean-toolchain``, the lakefile whitelist
  of the Packages section, and that no generated file is tracked by Git. The
  submission must be inside a Git repository; inability to inspect its tracked
  tree is a violation. This phase also derives each package's **module
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

- **Resolution** (milliseconds): check every direct and transitive Archive
  dependency against one exact database snapshot. Each direct git require
  must match a draft or registered record's canonical source triple and every
  dependency must provide a capture built against the archive pins. Draft
  dependencies are admitted with a warning; the separate Register action
  requires them to be registered. A local miss may mean the checkout at
  ``~/.lax/lax-database`` is stale, so the finding suggests ``lax pull-db``
  and a retry.

- **Provision:** ensure the pin-keyed **warm mathlib environment** exists and
  generate each package's complete ``lake-manifest.json`` and
  ``.lake/package-overrides.json``. In trusted validation, dependency captures
  are downloaded from GHCR by digest, verified, extracted read-only, and
  mounted with the VM-installed toolchain and warm workspace into fresh build
  workspaces. Local builds instead use exact git dependencies in the generated
  manifests and build them from source inside the package workspace. ``lax
  init`` performs the same local seeding for a fresh scaffold.

- **Compile:** run ``lake build`` for concepts first and proofs second. Trusted
  validation runs each package in a fresh, networkless, hardened container;
  the repository mount is read-only and only its isolated ``.lake`` build
  directories are writable. Local builds run through the pinned host
  toolchain in the submission's own packages and stream their transcript.
  When concepts fail, proofs are skipped.

- **Replay:** re-check every declaration of both packages with
  ``leanchecker`` from the pinned toolchain. The pipeline invokes it directly
  over a search path composed from the just-captured submission artifacts,
  verified dependency captures, and the warm mathlib workspace; it never uses
  ``lake env`` or dependency artifacts written during Compile. Trusted
  validation always replays. Local authoring skips Replay by default and
  enables it with ``lax build --replay``. Replay closes the hole left by
  unchecked elaboration APIs; dependency authenticity comes from their
  digest-addressed captures rather than from replay itself.

- **Inspect:** extract environment facts with the ``Lax.Inspector``
  executable, then judge every remaining rule in the TypeScript pipeline —
  including the import rule and root-module exactness — see below.

- **Emit:** after a successful full build, derive deterministic
  ``build-output.json`` and a capture manifest. The local CLI writes the file
  atomically into the submission root; trusted validation instead uploads the
  generated payload and sealed ``capture.tar`` for credential-free publication
  preflight. Partial builds emit neither.

In the authoritative GitHub Actions pipeline, Compile, Replay, and Inspect form a
trust chain. Compile is where untrusted code runs; nothing it outputs is
trustworthy on its own, because the submission's own elaboration wrote it.
Replay authenticates the oleans'
kernel-level content relative to their imports — every declaration
type-checks against the imported environment — and no more; Inspect
reports what the oleans say; the TypeScript validator decides whether that is admissible.
The imports themselves the chain cannot authenticate, only inherit: on the
runner they are provisioned from verified, immutable dependency captures, so
the background Replay checks against is exactly what an earlier trusted submit
published.

The inspector's facts accordingly carry two grades of trust.
**Kernel-grade:** kinds, types, values, and everything recomputed from them
— axiom sets, defeq — which trusted Replay makes impossible to forge within
the submission's own packages; for imported packages the same facts are
authentic by provisioning, not by replay.
**Metadata-grade:** import lists, constant-list membership, docstrings —
artifact data a malicious Compile could in principle fabricate. The rules
lean on metadata only where forgery cannot make a false thing true:
docstrings are authored content anyway, a forged import list can hide at
worst an editorial violation, and every cross-package claim is checked
against the database, never against the workspace (see Inspection
Internals). Source-structural facts — layout, lakefiles, manifest — never
pass through the oleans at all; the pipeline reads the files directly. The chain
bottoms out where the archive's trust always bottoms out: Lean's kernel,
the pinned toolchain and mathlib revision, digest-addressed dependency
captures, and the protected publication workflow.

Author-code execution and artifact processing use isolated containers from a
stock image pinned by digest. Each container is read-only and capability-free,
inherits only explicit mounts and environment values, and is limited to 16
GiB memory, four CPUs, 1,024 processes, bounded output and workspace size, and
phase timeouts. Replay and Inspect use two Lean workers.


### Inspection Scaffolding

All archive-side meta-programming lives in ``Lax.Inspector``, a Lean
package providing one executable: pinned to the archive toolchain,
importing only Lean core, never mathlib. (Replay needs no counterpart —
``leanchecker`` ships inside the toolchain itself.) The inspector's source
ships with the CLI; the first ``lax build`` on a machine compiles it into
``~/.lax/tools/<cli-version>-<source-hash>/`` and every later run of those
exact sources reuses it. Trusted runner setup builds the same pinned inspector
before submission code runs.

An executable, never an elaborated command: the inspector loads the
package's oleans directly and executes no code originating outside its own
binary and Lean core. Importing a module must not run its ``initialize``
blocks — arbitrary interpreted IO — and nothing imported may be evaluated,
because once untrusted code runs in the inspecting process, nothing that
process writes is authentic. What remains is enough:
docstrings, module docs, and constant lists are persisted data readable
through core's built-in machinery, axiom walks are pure traversals, and
defeq is kernel reduction, not interpretation.

The boundary between inspector and TypeScript validator is drawn by capability:
the inspector computes exactly the facts the validator cannot — everything
whose evaluation needs the loaded environment or the kernel — and the validator, which alone holds the
archive context (the verified ``[[require]]`` set, the manifest, the
database), judges every rule. The inspector decides nothing about validity:
a failed defeq or a malformed frontmatter appears in the report as a fact
and becomes a violation only in the validator, the sole emitter of violations.

One placement follows from this and deserves its reason spelled out:
frontmatter is parsed by the inspector, not the validator. The kernel facts about
a proof — does its ``conclusion`` resolve, does defeq hold — are indexed by
a name that sits inside its docstring's frontmatter, so whoever parses the
frontmatter determines the number of passes over the environment: parsing
in the validator would force a second inspector run to feed the names back in.
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
submission's too. The report
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
the validator, one comparison against an allowed set — the only question is what
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
  draft or registered submission, and its trusted submit pipeline enforced
  that rule on it. One
  cross-check guards the metadata: the axiom's name must also appear among
  the ``statements`` in that submission's ``build-output.json`` in the
  database — the database, not the workspace, is the authority on another
  submission's statements, so a forged module masquerading under a required
  package's name classifies as nothing. The name comparison alone would not
  survive a forgery that keeps the registered names and changes the types
  beneath them; it is sound because the upstream oleans themselves are
  authentic where the verdict counts — provisioned from their verified
  digest-addressed captures (see GitHub Actions).

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
prefix test in the validator: an import's first component identifies its package
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
parsed frontmatter and its kernel facts, and the validator adds the context: the
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
Emit copies files into ``sourceText`` with line endings normalized to LF,
which is a copy, not a parse.


## Site Generator

The site generator is maintained in the separate ``lax-website`` repository.
It reads all three files in each database folder and emits deterministic
submission, concept, and proof pages, a searchable archive index, citations,
and concept, submission, and proof-network views. It renders Markdown, math,
annotation sections, Lean source, and proven or unproven statement status.
Records without content-bearing build output, including init reservations and
deleted tombstones, produce no submission pages. The CLI bundles the
page-builder from a pinned Website revision for ``lax serve``.


## Database Repository

The folder tree of the Archive Database section is the canonical state of the
archive; everything else is derived. ``lax-archive/lax-database`` is a public
Git repository. Only protected GitHub Actions publication jobs may mint the
short-lived GitHub App token that advances its default branch, and they do so
without force after revalidating the current head. ``lax pull-db`` clones or
fast-forwards a read-only checkout at ``~/.lax/lax-database``. The path is
deliberately visible so authors and agents can survey existing work.


## CLI

The acting GitHub account authenticates through the Lax GitHub App: ``lax
login`` runs its device flow and stores the resulting user and refresh tokens.
The CLI creates issues and exact command comments; it never writes the database
directly. ``lax`` has the following commands:

**lax init [folder]** (default ``.``) starts a submission, see Actions. The
folder must be empty or not yet exist; otherwise init refuses. The folder is
checked before the issue is created, so a refused init burns no id. The scaffold
comprises ``manifest.yaml`` (with ``id: lax-N`` and the environment pins),
package folders, lakefiles (with the mandatory mathlib require), ``lean-toolchain``,
root modules, ``abstract.md``, ``LICENSE``, and a ``.gitignore`` covering
``build-output.json``, ``lake-manifest.json``, and ``.lake/``. Init then builds
or reuses the shared warm mathlib environment and seeds both generated
manifests and package overrides, so plain ``lake build`` works immediately.
It may scaffold outside Git with a warning, but the folder must enter a Git
repository before ``lax build`` or ``lax submit``.

**lax owners <target> --new-list <handle>...** replaces the owner set with the
given GitHub handles, resolved to numeric account ids (see Archive Database).
The target is a ``lax-N`` id or a submission folder.

**lax build [folder]** runs the local authoring pipeline through host
``elan``/``lake`` and writes ``build-output.json`` after a successful full
build. It skips kernel Replay by default; ``--replay`` enables it,
``--profile`` prints phase timings, and ``--build-from-source`` builds mathlib
locally when its prebuilt artifact cache cannot be fetched. ``--only
concepts`` and ``--only proofs`` provide partial iteration builds without
replacing ``build-output.json``; proofs-only still builds concepts as its
prerequisite but skips concept Replay. Registration never trusts local output:
the GitHub Actions workflow rebuilds a submitted commit with Replay mandatory.

**lax serve [folder]** runs the **site generator** and serves the result
locally. It is a long-running process that does not daemonize by default. It
starts at ``http://localhost:8123/`` with a loading page, then watches both the
complete local database and the submission's ``build-output.json``. Every
change triggers a website rebuild. The local folder is
rendered from its own ``build-output.json`` against a synthetic draft record,
so ``lax serve`` works before ``lax init`` has allocated an id. If
``build-output.json`` is missing, the website shows a placeholder stating that
the output has not been generated yet; ``lax serve`` does not build. It warns
when the database is missing, stale, invalid, or unreachable.
``--database-only`` omits the local folder and ``--port`` selects another port.

**Continuous preview while authoring.** Keep ``lax serve`` running in one
terminal and open the URL it prints. After each successfully completed proof
or meaningful milestone, authors and automated proof-building agents should
run a full build of the submission in another terminal:

```sh
# Terminal 1: keep the local preview running.
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
within the repository — and normalizes the supported providers' SCP or SSH
clone spellings to credential-free HTTPS URLs, removing a trailing ``.git``.
URLs containing credentials, ports, queries, or fragments are rejected. By default
it requires a clean worktree and a HEAD present on ``origin``. Before posting
the command it reuses a matching full local build or runs ``lax build``.
``--allow-dirty`` still submits committed HEAD, excluding local changes, and
validates it in an isolated worktree. ``-f``/``--force`` skips the dirty,
pushed-HEAD, and local-build checks entirely, leaving the trusted workflow as
the only verdict. Submit always produces a replaceable draft.

The explicit form ``lax submit <lax-N> --repository <url> --commit <sha>
[--folder <path>]`` posts a validated source triple without local Git or build
checks. ``lax submit --resume [folder]`` re-derives the originating command and
durable Actions run from issue comments after a transport failure; no local job
id is required.

**lax register <target>** makes an init or draft record immutable, and **lax
delete <target>** permanently replaces it with a tombstone. Both refresh and
preflight the local database and require the user to type ``lax-N`` unless
``--yes`` is supplied.

**lax pull-db** refreshes the local database checkout at
``~/.lax/lax-database``, see Database Repository. It is read-only with respect
to the archive and needs no authentication.

**lax update** upgrades the CLI itself to the latest release and then refreshes
the local database and current Website renderer; ``lax upgrade`` is an alias.
Likewise needs no authentication. **lax doctor** checks the issue-workflow
toolchain, login, local database, host Lean setup, and bundled Website renderer
and reports concrete fixes.

**lax login** uses the GitHub App device flow and accepts only the resulting
``ghu_`` user access token. Expiring credentials are refreshed with the
rotating ``ghr_`` refresh token stored under ``LAX_HOME``; generic OAuth and
personal access tokens are rejected. The user token may create issues and
comments in the control repository but has no database or Website installation
authority. **lax logout** revokes both stored tokens with GitHub before removing
them locally.

**lax spec** prints this specification. The text is bundled with the CLI, so
the printed spec is exactly the one shipped in that release.
Useful for agents authoring submissions.


## GitHub Actions

The archive has no long-running application server. The public
``lax-archive/lax`` repository, its issues, and its GitHub Actions workflows
form the write control plane; the public database remains the read surface.

- **Authentication and commands.** The GitHub App user token lets the CLI open
  the authoritative issue or post exact ``/lax owners``, ``/lax submit``,
  ``/lax register``, and ``/lax delete`` comments. Edits do not execute. GitHub
  authenticates the actor before emitting the event; the router binds the
  issue number to ``lax-N`` and authorizes the actor by numeric account id. It
  has only the repository-scoped workflow token and no Archive write
  credential.

- **Validation isolation.** Submit validation runs as one credential-free job
  on an ephemeral GitHub-hosted runner. Source fetching, static checks, and
  resolution happen before author code runs. Compile, Replay, Inspect, capture
  download/extraction, and sealing use fresh containers from a stock image
  pinned by digest. The pinned toolchain, warm mathlib workspace, inspector,
  and helper tools are installed on the VM and mounted read-only. Compile gets
  a copy of committed source plus isolated writable build directories; Replay
  and Inspect read only the captured submission artifacts and verified
  dependency captures. The runner's reusable cache is saved before any
  untrusted code executes.

- **Validation artifacts and captures.** A successful validation uploads the
  validation report, phase profile, generated build output, and ``capture.tar``
  as workflow artifacts. Before any publication credential exists, a separate
  preflight parses their exact schemas and verifies the source commit, runtime
  identity, capture digest, per-file hashes, issue binding, lifecycle state,
  owners, stale-write inputs, and dependency captures. The protected publisher
  then pushes the capture as a digest-addressed OCI blob to
  ``ghcr.io/lax-archive/lax-captures`` and records that digest reference in
  ``build-output.json``. If the database update later loses a race, an orphaned
  blob is harmless; no uncommitted capture becomes authoritative.

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
  current job and step, and waits for a bot-authored result. Owners and submit
  commands carry a 🚀 reaction while running and a 👍 on complete success;
  owners use that reaction as their only success result. Initialization,
  submit, register, and delete retain result comments with machine-readable
  success or failure markers. A CLI disconnect can therefore resume from issue
  history instead of an in-memory job id.

- **Website dispatch.** After a successful database commit, a separate job in
  the protected ``lax-website-dispatch`` environment can mint only a Website
  Dispatcher token restricted to ``lax-website``. It sends the rebuild event
  and reports whether dispatch was accepted; the Website repository owns the
  actual build and GitHub Pages deployment. A dispatch or issue-title sync
  failure is reported as an operation failure even when the canonical database
  commit already succeeded, and never rolls that commit back.

## Distribution and Deployment

The CLI is the one component users install. We distribute via npm (package
``lax-archive``), making installs and updates one-liners; ``lax update``
runs ``npm install -g lax-archive@latest`` and then refreshes the database and
current Website renderer.

Local builds shell out to ``elan``/``lake`` for the pinned host toolchain and
to ``git`` for source checks and the database clone; ``lax update`` also needs
``npm``. Docker is required only by trusted validation, not by CLI authoring.
The CLI speaks the GitHub App flow and API directly, so no GitHub CLI is
required, and names missing command dependencies during preflight.

The npm CLI and ``submission.yml`` share the TypeScript validators and
inspection judgments; the workflow adds isolated execution, mandatory Replay,
capture sealing, and publication. The Website renderer is built in the
separate ``lax-website`` repository and bundled from the revision pinned in
this repository. ``release.yml`` runs checks, verifies that renderer bundle,
and publishes through npm trusted publishing on version tags; ordinary CI runs
on every push.

### Environment variables

All lax-specific configuration is environment variables; none is needed in
normal use.

CLI:

- ``LAX_HOME`` (default ``~/.lax``): the CLI's machine state — the database
  clone (``lax-database/``), credentials, warm mathlib workspace (``warm/``),
  compiled tools, and update-check state.
- ``LAX_GITHUB_APP_USER_TOKEN``: an existing ``ghu_`` GitHub App user token
  used instead of stored ``lax login`` credentials (CI and agents).
- ``LAX_DATABASE_URL``: override the public database clone URL;
  ``LAX_DB_URL`` remains a legacy alias.
- ``LAX_POLL_INTERVAL_MS`` and ``LAX_WORKFLOW_TIMEOUT_MS``: override the
  workflow polling interval and overall wait limit.
- ``LAX_DATABASE_POLL_INTERVAL_MS``: override how often ``lax serve`` checks
  database freshness.
- ``LAX_DISABLE_UPDATE_CHECK=1``: disable the best-effort background release
  check.

GitHub Actions deployment:

- Repository variable ``LAX_REPOSITORY_ID`` fixes the immutable numeric id of
  ``lax-archive/lax``.
- The protected ``lax-database-publish`` environment provides
  ``LAX_DATABASE_APP_ID`` and ``LAX_DATABASE_APP_PRIVATE_KEY`` for an App
  installed only on ``lax-database`` with Contents write.
- The protected ``lax-website-dispatch`` environment provides
  ``LAX_WEBSITE_APP_ID`` and ``LAX_WEBSITE_APP_PRIVATE_KEY`` for a different
  App installed only on ``lax-website`` with Contents write.
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
