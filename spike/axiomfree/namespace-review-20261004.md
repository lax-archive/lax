# Namespace review: do the spec-2 namespace rules make records composable?

Independent review, 2026-10-04. Question: what namespace conventions on proof
packages (and concept packages) make it always possible to import any set of
one environment's records into one Lean environment, and does the current rule
achieve that. Sources: Lean v4.35.0-rc3 (`Lean/Environment.lean`
`finalizeImport`/`subsumesInfo`/`throwAlreadyImported`, `Lean/Modifiers.lean`,
`Lean/ResolveName.lean`, `Lean/ReservedNameAction.lean`, `Lean/Meta/Eqns.lean`,
`Lean/Meta/Match/MatchEqs.lean`, `Lean/Meta/Tactic/BVDecide/Normalize/Enums.lean`
and every other `realizeConst` caller), `spec_v2_draft.md` (Namespaces, the
proof-package Namespace bullet, the primer, "The namespace check"), `spec.md`
(the spec-1 original), `src/submission-validation/phases/inspect-common.ts`
(`checkNamespace`), `phases/inspect-spec2.ts`, `phases/inspect.ts`
(`checkRootModule`, `checkImports`, `uniqueDeclarations`),
`lean/inspector/Main.lean` (`userLevelName?`), `validators/lakefile.ts`,
`certify/generate.ts`, `certify/compose.ts`, `certify/phase.ts`. Empirical
checks ran in a core-only Lake project on the rc3 toolchain
(scratchpad `clash/`, section 4).

**Verdict in one paragraph.** For *declared constants* the current rule is
sufficient and I could not break it: every name an author writes or Lean
generates at a declaration site extends the declaration's name, declarations
sit under a per-record prefix (`LaxN.<Module>` / `LaxNProofs`), and Lean
refuses two constants of the same name unless both are theorems of identical
type — so two records can never contribute the same user-level name. The
gaps are elsewhere: (1) one Lean *realization* is a public `def` filed under
an imported constant's name (`<enum>.enumToBitVec`, realized by `bv_normalize`
/`bv_decide`'s normalizer for any enum inductive) — the inspector drops it as
reserved, it survives the archive's axiom rules, and two records that both
realize it for the same mathlib/concept enum cannot be imported together
(verified). (2) Global state that is not a constant — environment extension
names registered by `initialize`, and parser/macro/elaborator tables — is
invisible to a name-prefix rule: same-named extensions make the import fail
(verified), and a global `macro_rules`/`syntax` in any record changes how
*every* importer's `theorem` command elaborates, including the generated
Challenge/Solution (verified: a concept-package macro turns `theorem Cert.p :
1 = 2 := sorry` into `Cert.p : True`, axiom-free, which `lake comparator`
would accept). Neither gap is a namespace problem, but both break the
composition requirement, and both are checkable per record from the olean.

## 1. The composition requirement in Lean's terms

`lake build` of a module whose header imports a set of modules M₁…Mₖ calls
`importModules`, which loads the transitive closure of `.olean`s, then
`finalizeImport` folds every module's `constNames`/`constants` into one
`privateConstantMap`, in import order. For each name already present it
applies `subsumesInfo` both ways (Environment.lean:2269–2344); if neither
direction holds, it throws

    import <M> failed, environment already contains '<c>' from <M'>

`subsumesInfo c₁ c₂` requires the same name, *syntactically equal* `type`,
equal `levelParams` (names and order), and then: both theorems with equal
`all`; a theorem vs an axiom with `all = [name]` (the module system's
exported form); two axioms with cheap-Prop types. Anything else — two `def`s,
`def` vs `theorem`, two `instance`s, two `inductive`s — is refused. Values are
not compared; the later module's theorem wins (`insert cname cinfo`; verified
with `#print`: the second import's proof term is the one in the environment).

After the constants, `setImportedEntries` loads every module's environment
extension entries. Persistent extensions are keyed by their registered name;
registering a second extension of a name already registered throws

    invalid environment extension, '<name>' has already been used

during `initialize` execution, i.e. at import time of any file that imports
both registering modules in a process that runs initializers (`lean` does:
`Elab/Import.lean:159` imports with `loadExts := true`).

Private names are per module by construction: `mkPrivateName env n =
_private.<env.mainModule>.0.<n>` (Modifiers.lean:23), so two modules' private
`helper`s are distinct constants (verified). Hygienic auxiliaries
(`_aux_<module>_…`, `…._@.<module>._hyg.N`) embed the module name too.

Reserved names (`f.eq_<n>`, `f.eq_def`, `f.eq_unfold`, `f.congr_simp`,
`f.hcongr_<n>`, `f.induct`, `f.fun_cases`, `S.mk.injEq`, `<matcher>.splitter`,
`<enum>.enumToBitVec`, …) are *not* declared where their parent is: any
module that first needs one runs the registered `ReservedNameAction`, which
calls `realizeConst`, and the resulting constant is persisted in **the
realizing module's** olean under the parent's name. Several modules may
realize the same name; that is exactly the case `subsumesInfo`'s theorem
tolerance was written for (its doc comment: "We want to generate equational
theorems on demand and potentially in different files"). Realizations for
imported constants run on the state just after import with the command-line
options (`Meta.realizeConst` doc), and the equation generators re-impose the
options recorded at the parent's definition (`withEqnOptions`), so two
records produce the same type for the same reserved theorem; the lakefile
rule pins `leanOptions` to `autoImplicit = false` alone, so there is no
command-line variance either.

So the requirement is: **for every pair of records R₁ ≠ R₂ in the
environment, and every constant name c, if both R₁ and R₂ contribute c then
c is a theorem (or `mkThmOrUnsafeDef` of a safe parent) of identical type
and level parameters; no two records register a persistent environment
extension of the same name; and nothing either record adds to the global
parser/macro/elaborator tables changes how the generated certificate text
parses or elaborates.** The current spec states only the first clause's
name-prefix sufficient condition.

How `_root_` resolves matters for the composition site: `resolveGlobalName`
tries `resolveUsingNamespace` (namespace-prefixed lookups — a prefix a record
cannot declare under, since it starts with `Cert`), then `resolveExact`, which
strips `_root_` and accepts the name iff `containsDeclOrReserved` — aliases
(`export`) are consulted only on the non-exact path (ResolveName.lean:154–211).
So `_root_.Lax1Proofs.p` in Solution.lean can never be redirected by another
record's `export`, only by a constant of exactly that name (verified: a
root-level `export Lax2Proofs (q)` leaves `@_root_.Lax1Proofs.q` resolving to
`Lax1Proofs.q`).

## 2. Clash classes

Columns: how it arises; what Lean does when two records are imported together;
whether the current rule (user-level name carries the module/package prefix;
root module declares nothing; private proofs refused) prevents it; the rule
that would. "Verified" means run on rc3 in section 4.

| # | Class | How it arises | Lean on co-import | Current rule | Rule that prevents it |
|---|---|---|---|---|---|
| A1 | Auto-named instance at the root | `instance : Foo Nat` outside any namespace in two records → both `instFooNat` | **Refused** (`def` vs `def`; verified: `environment already contains 'instFooNat'`) | Prevents: `instFooNat` is user-level and lacks the prefix → `namespace` violation | current |
| A2 | Auto-named instance inside the namespace | same inside `namespace LaxNProofs` → `Lax1Proofs.instFooNat`, `Lax2Proofs.instFooNat` | Accepted; instance resolution in a *later* file picks the most recent — but no stored constant changes meaning, and the certificate performs no instance search (statements are `Prop` constants, hypotheses are passed explicitly, `instImplicit` binders are copied with `checkBinderAnnotations false`) | Prevents the clash; the semantic drift is irrelevant to the certificate | current |
| A3 | `deriving` handlers | `deriving Repr` on a record's own type → `LaxN.M.instReprS`, `LaxN.M.instReprS.repr`, `instDecidableEqS.decEq._proof_1`; `deriving instance Inhabited for <imported type>` → `instInhabited<Type>` under the *current namespace* (verified: `Lax1Proofs.instInhabitedCol`) | Refused only when both land at the root | Prevents (root case fails the prefix; namespaced case is prefixed) | current |
| A4 | `structure`/`inductive` internals | `S.mk`, `S.rec`, `S.casesOn`, `S.recOn`, `S.noConfusion(Type)`, `S.ctorIdx`, `S.mk.injEq`, `S.mk.inj`, `S.mk.sizeOf_spec`, `S._sizeOf_1`, `S._sizeOf_inst`, `S.mk._flat_ctor`, `E.ctorElim`, `E.a.elim` (verified list) | Refused iff `S` itself is duplicated, which the prefix rule forbids | Prevents: every name extends `S` | current |
| B1 | Realized **theorems** under an imported function's name | `simp [f]`, `rw [f.eq_def]`, `unfold f`, `split`, `fun_induction`, `congr` on a mathlib/concept/LaxCore `f` persist `f.eq_<n>`, `f.eq_def`, `f.eq_unfold`, `f.congr_simp`, `f.hcongr_<n>`, `f.induct`, `f.fun_cases`, `f.match_<n>.congr_eq_<n>`, `<matcher>.eq_<n>` (private), `S.mk.injEq`, `instName.<method>_spec`, enum `eq_iff_enumToBitVec_eq`/`enumToBitVec_le`, … in **each realizing record's** olean | **Accepted**: theorem, identical type and levels (`subsumesInfo`; verified: `f.eq_def` in two modules, co-import fine). Realizations for imported constants are deterministic (section 1) | Inspector drops them as reserved before the prefix test (`userLevelName?`); no finding, no clash — correct | current, provided `leanOptions` stays pinned (validators/lakefile.ts) and every realizer stays theorem-kind (audit the list below on each toolchain bump) |
| B2 | Realized **definitions** under an imported name | The only public one in rc3: `<enum>.enumToBitVec` (`Meta/Tactic/BVDecide/Normalize/Enums.lean:73`, `addDecl <| .defnDecl`), realized by the bv_decide normalizer for any enum inductive mentioned in the goal — including `bv_normalize` alone, which uses no native axiom (verified: `Lax3Proofs.k` depends on `[propext, Classical.choice, Quot.sound]` only and its module contains `def Col.enumToBitVec`). `<matcher>.splitter` is also a def but is deliberately private per module (MatchEqs.lean:143–151, verified `_private.T.E1.0.f.match_1.splitter`), so it does not clash | **Refused** (verified: `environment already contains 'Col.enumToBitVec' from T.K1`) | **Not prevented**: `isReservedName` is true for it, so `userLevelName?` returns `none` and `checkNamespace` never sees it; the axiom rules pass (`bv_normalize`); the record validates, and any pair of such records over the same enum fails to compose. (Full `bv_decide` is already refused — it adds an `axiom Lax…k._native.bv_decide.ax_*` and `Lean.ofReduceBool` — but that is incidental) | Add to the inspector: *any constant of non-theorem kind that a package contributes under a name whose user-level prefix is outside the package* is a violation, reserved or not (equivalently: the reserved-name exemption applies to theorem kind only). Message: "realized definition `X` under an imported name; use a different tactic". Mathlib's `Fin`-based `decide` route is unaffected |
| C1 | `private` with the same short name in two records | `private def helper` twice | Accepted: `_private.<M₁>.0.helper` ≠ `_private.<M₂>.0.helper` (verified) | Not a clash; the rule un-mangles and tests the prefix (a root-level private fails it) | current |
| C2 | `protected` | affects resolution only when the namespace is `open`ed; the certificate never opens one | nothing | n/a | current |
| C3 | `export` / `open … in` | `export` adds aliases (extension entries, no constants). A record's `namespace Lax1Proofs export Lax2Proofs (q)` creates alias `Lax1Proofs.q` *into another record's namespace*; a root-level `export` creates a root alias | Accepted; `_root_.` resolution ignores aliases (`resolveExact`), so Solution/Challenge are unaffected (verified: `@_root_.Lax1Proofs.q` still resolves to the real theorem with the alias present); only non-`_root_` references in *later-authored* files see ambiguity | Not seen by the rule (no constant); harmless to composition | optional hygiene: forbid `export` into a namespace outside the package (checkable from the `aliasExtension` entries of the olean). Not needed for composition |
| C4 | `_root_.` escapes | `theorem _root_.Nat.foo` from a proof package | Refused only if two records pick the same name and non-theorem kind, or same name with different types; identical theorems are silently merged | Prevents: `Nat.foo` fails the prefix (verified the name lands as `Nat.lax_lemma`, user-level) | current |
| C5 | A proof package declaring under a concept namespace or mathlib's | `theorem Lax1.M.foo` or `theorem Nat.foo` from `Lax2Proofs` | as C4 | Prevents (prefix) | current |
| D1 | Two `def`s with the same name | only possible across records via C4/C5 | Refused (verified) | Prevents | current |
| D2 | Two theorems, same name, same type, different proofs | only via C4/C5 | **Accepted silently**; later import's value wins. Harmless for `Prop` by proof irrelevance; a `def`-kind "proof" of a Prop is refused (verified `def` vs `theorem`) | Prevents across records (prefix). *Within one package* two modules may both declare `theorem Lax1Proofs.p` with the same type: the root import succeeds, `uniqueDeclarations` (inspect.ts:322) keeps the first report entry, the record has one proof id, and `_root_.Lax1Proofs.p` in the Solution is the later module's term — same edge, so sound, but the record's line ranges/docstring may describe the other copy | make a within-package duplicate name a violation (the inspector reports both; dedupe by `(name, module)` instead and fail on a repeated `name`) |
| D3 | Two theorems, same name, different types or different level-parameter *names* | via C4/C5 | Refused (verified both: `1 = 1` vs `True`; `.{u}` vs `.{v}` of the same statement) | Prevents | current |
| E1 | `syntax`/`notation`/`macro_rules`/`elab` declared **globally** inside the namespace | `namespace Lax1Proofs notation "⊕⊕" => …` → constants `Lax1Proofs.«term⊕⊕»`, `Lax1Proofs._aux_…macroRules…` (prefixed, verified) but the parser/macro tables are global | Import **accepted**; a later file using the token sees "Ambiguous term" when two records define it (verified). Worse, a record can extend or override syntax the certificate itself uses: `syntax (priority := high) "@" ident : term` + a macro makes `@_root_.Lax2Proofs.q` elaborate to `True.intro` (verified: Solution-shaped theorem fails with a type mismatch), and `macro_rules` for `declaration` rewrites every importer's `theorem` command (verified: a concept-package macro turns `theorem Cert.p : 1 = 2 := sorry` into `Cert.p : True` with no axioms — both Challenge and Solution would be rewritten identically and `lake comparator` would pass a vacuous certificate) | **Not prevented** — the constants carry the prefix; the table entries are not names | Require every syntax extension in a record to be `scoped` or `local` (verified: the `scoped` variant of the `@` hijack leaves `@_root_.Lax3Proofs.q` intact in a file that does not `open Lax3Proofs`). Checkable per record from the olean: entries of `Lean.Parser.parserExtension`, `macroAttribute`, `termElabAttribute`, `commandElabAttribute`, `macroRulesAttribute`-generated tables are `ScopedEnvExtension` entries whose global vs scoped status is persisted; a global entry contributed by a record module is a violation. A root-level `notation` is also a plain D1 clash (`«term⊕⊕⊕»`, verified refused) and is already caught as a user-level root name |
| E2 | Attributes applied to imported declarations | `attribute [simp] Nat.add_comm`, `attribute [instance] …`, `@[reducible]`, `attribute [ext] <mathlib structure>` (the last also *generates* `Foo.ext` theorems — user-level under another namespace, caught) | Accepted; global simp/instance/reducibility state of every importer changes. The certificate text contains no `simp`, no instance search and no unfolding (types are syntactically the same constants), so no effect on composition | Not seen; harmless to the certificate; affects only other authors' elaboration if they import both | as E1 if desired (`scoped`/`local` attributes); not required for composition |
| F1 | `initialize` registering a persistent env extension | `initialize myExt : … ← registerSimplePersistentEnvExtension { name := \`laxSharedExt … }` in two records (needs only `import Lean`, which `coreImportRoots` admits) | **Refused at import** of any file importing both: `invalid environment extension, 'laxSharedExt' has already been used` (verified). With the default `name := decl_name%` the names are `Lax1Proofs.myExt`/`Lax2Proofs.myExt` and co-import works (verified) | **Not prevented**: the constant is `opaque Lax1Proofs.myExt` (prefixed) plus a private `initFn`; the extension name is a string in the initializer body | Forbid `initialize`/`builtin_initialize` in records outright (the `init` attribute's entries are in the olean's `regularInitAttr` extension; also the generated `…initFn._@…` constant is recognizable). Independently of names, an `initialize` runs arbitrary IO in every importer's `lean` process — container B's notes in certify/phase.ts already treat the proof package's initializers as untrusted; a reader running `lax certify --run` locally does not have that container |
| F2 | `register_option`, `register_simp_attr`, `declare_syntax_cat`, `initialize` reserved-name predicates | all are `initialize` sugar | as F1 (name-keyed global registries) | not prevented | covered by the F1 ban |
| G1 | Root-module rule | the root module `LaxN`/`LaxNProofs` imports exactly the inventory, declares nothing, no docstring | n/a to co-import | Enforced (`checkRootModule`) | current. Module-name uniqueness holds by construction: every module of a record is `LaxN.<X>` or `LaxNProofs.<X…>` (inventory.ts), record ids are distinct, and no environment library has a `LaxN` root. Everything keyed by module name (private mangling, `_aux_<module>`, hygiene scopes, `initFn`) is therefore unique across records. Lake package names are also the record ids, so the certificate's `[[require]]` list has no duplicates |
| H1 | The certificate project's own names | `LaxCertificate` package, modules `Challenge`/`Solution`, theorems `Cert.<proof-id>` / `Cert.<statement-id>` | A record cannot declare under `Cert` (prefix rule; `_root_.Cert.…` fails it), cannot have a module named `Challenge`/`Solution` (inventory prefixes), cannot be a package named `LaxCertificate` (id pattern). `Cert.LaxNProofs.p` vs `Cert.LaxN.M.S` cannot coincide (first components differ). Body resolution inside `theorem Cert.Lax1Proofs.p` runs with namespaces `Cert`, `Cert.Lax1Proofs` open, which only `Cert.…` constants could pollute — none exist | prevented | current. One assumption to keep: no environment library (mathlib, LaxCore, CSLib) ever declares a `Cert` namespace or a `Challenge`/`Solution` module |
| H2 | Universe-polymorphic duplicates in composition | two proofs compose only by `_root_` names with explicit `.{…}` instances; the generated theorem copies level names | n/a to import; `compose.ts` refuses undetermined/colliding instances | — | current |
| I1 | `@[extern]`/`@[export]` symbol names | two records exporting the C symbol `lean_foo` | nothing at `lake build` of libraries (no link step); a clash only if someone links both into one executable | not seen | out of scope for composition; forbid `@[extern]`/`@[export]` anyway if the archive wants no FFI |
| I2 | `unsafe` definitions | `mkThmOrUnsafeDef` realizes equation lemmas of an `unsafe` parent as unsafe **defs** → two records realizing them would clash | refused | not prevented | an `unsafe` constant cannot occur in a theorem, so a proof package cannot reach this; forbid `unsafe`/`partial` definitions in records if a belt is wanted |

Non-findings worth recording: `example` persists nothing; `theorem p.foo` with `p` a theorem is fine; a constant named exactly like its prefix (`def Lax1.M`) is admitted by `name === prefix` and is harmless to `_root_` resolution; the concept-package rule (prefix = module name) and the proof-package rule (prefix = package name) both yield pairwise-disjoint prefixes across records, and `Lax1.` is not a prefix of `Lax10.…` because the test appends the dot.

## 3. Recommended convention

Normative paragraph, in the spec's voice:

> **Namespaces.** Every constant a concept module declares carries the module
> name as a prefix (`Lax261.Myconcept.…`); every constant a proof package
> declares carries the package name (`Lax261Proofs.…`). The test is on the
> user-level name — internal details dropped, private names un-mangled — and
> applies to everything the module contributes, authored or generated. The
> one exception is a reserved name Lean realizes under an imported constant
> (`f.eq_1`, `f.congr_simp`, `S.mk.injEq`, …), which is admitted **only if it
> is a theorem**: a realized definition under an imported name (today,
> `<enum>.enumToBitVec` from the `bv_decide` normalizer) is a violation,
> because Lean refuses to import two modules that both define it. A record
> declares no `initialize` (nor its sugar: `register_option`,
> `register_simp_attr`, `declare_syntax_cat`, persistent extensions), and
> every `syntax`, `notation`, `macro`, `macro_rules`, `elab`, and attribute
> application it makes is `scoped` or `local`, never global — names cannot
> keep global tables apart, and a global rule rewrites every importer,
> including the archive's certificates. Within one package, a name is
> declared once. Under these rules any set of the environment's records
> imports into one Lean environment, and the generated Challenge and Solution
> elaborate as written.

Validator checks, all local to one record, all from the built oleans:

1. `checkNamespace` as today, plus: for every constant the package contributes
   with `kind ≠ "theorem"`, the user-level prefix test applies *even when
   the name is reserved* (drop the `isReservedName` short-circuit for
   non-theorems in `userLevelName?`, or report `reserved: true` and let the
   TS side decide).
2. `initialize`: fail on any entry of `regularInitAttr`/`builtinInitAttr` in a
   record module's olean (or, cheaper, any constant whose name contains the
   component `initFn`).
3. Global syntax state: fail on any non-scoped entry a record module
   contributes to the parser, macro, term-elab, command-elab, and
   (optionally) attribute extensions. The olean stores these as
   `ScopedEnvExtension` entries with their scope; `loadExts := false` leaves
   the raw entries readable, as `matcherNamesOf` already does.
4. Within-package duplicates: the inspector reports every `(name, module)`;
   a repeated `name` is a violation instead of being deduped.

Author-facing phrasing (for assets/instructions.md): "put everything under
`namespace LaxNNNProofs`; never `_root_`; never `initialize`; write `scoped
notation`/`scoped macro_rules`/`local attribute`; avoid `bv_decide`/
`bv_normalize` on enums you did not define."

## 4. Tested empirically vs reasoned from source

Tested on `leanprover/lean4:v4.35.0-rc3`, core-only Lake project
(scratchpad `clash/`, library `T`, one module pair plus a joining module per
class; `ListConsts.lean` dumps each module's `constNames` with `kind`,
`isInternalDetail`, `isReservedName`):

- A1 refused (`instFooNat`); A2 accepted, `Foo.x` resolves to the later
  instance; A3 names (`Lax1Proofs.instInhabitedCol`, `Lax1.M.instReprS`, …);
  A4 full generated-name list for a `structure`/`inductive` with `deriving`.
- B1 `f.eq_def`/`f.eq_1`/`f.eq_2` realized in two modules, co-import
  accepted; `f.match_1.splitter` persisted as `_private.<module>.0.…`.
- B2 `Col.enumToBitVec` (def, reserved) realized by `bv_decide` and by
  `bv_normalize` + `simp_all` (the latter axiom-free); co-import refused.
- C1 private names distinct; C3 `export` into another namespace leaves
  `_root_` resolution intact; C4/C5 `Nat.lax_lemma` is a user-level name.
- D1/D2/D3 all four combinations (def/def refused; thm/thm same type accepted,
  later value wins; thm/def refused; thm/thm different type refused; same
  type with level names `u` vs `v` refused).
- E1 same notation in two namespaces → ambiguous use; same root notation →
  refused on `«term⊕⊕⊕»`; global `@ ident` syntax breaks `@_root_.X`
  applications; global `macro_rules` for `declaration` rewrites an importer's
  `theorem … : 1 = 2 := sorry` into `: True` with no axioms; the `scoped`
  variant is inert without `open`.
- F1 same extension name refused at import; default-named extensions
  co-import.

Reasoned from source only: `subsumesInfo`'s exact conditions; `_root_`
resolution order and alias exclusion (`ResolveName.lean`); determinism of
realizations for imported constants (`Meta.realizeConst` doc,
`withEqnOptions`, pinned `leanOptions`); the kind of every registered
realizer (grep of `realizeConst` callers: all `thmDecl`/`mkThmOrUnsafeDef`
except the private matcher splitter and the public `enumToBitVec`); that the
certificate's text performs no instance search, simp, or unfolding; the
`uniqueDeclarations` within-package behaviour (D2); module-name uniqueness
from `inventory.ts`; I1/I2.

Not tested: mathlib-level realizations (`to_additive`, `simps`, `ext` on
imported structures), the `module`-system variant of a record, and the real
`lake comparator` on a hijacked Challenge/Solution pair (the elaboration
result alone is conclusive for E1).

## 5. Open questions

1. **E1 at the composition site.** The certificate scheme assumes the
   Challenge's `Cert.<id>` elaborates to the telescope lax wrote. A global
   macro in any package the Challenge imports can change that while keeping
   both exports consistent and axiom-free. Beyond the `scoped`-only rule,
   should the trusted Certify phase (or the judge) check the *exported*
   Challenge theorem's type against the recorded telescope (the constants and
   their level instances are known), so the certificate is held to the
   archive's reading and not only to the comparator's? A reader of a bundle
   has no such check at all.
2. **B2 on toolchain bumps.** The "theorem-only realizations" fact is a
   property of the current realizer set. Each environment admission should
   re-run the realizer grep (section 4) or, better, the inspector should
   enforce rule 1 of section 3 so a new public realized def surfaces as a
   violation instead of a composition failure months later.
3. **Should the archive compose the records' environments eagerly?** A cheap
   end-to-end guard: a scheduled job that builds one file importing every
   proof package of an environment. It catches every class in the table
   except E2 and would have caught B2/F1 before the first relative
   certificate across the offending pair.
4. **`uniqueDeclarations` (D2).** Deliberate tolerance or an oversight? If
   deliberate, the record should at least say which module's copy the id
   refers to.
5. **Readers' machines.** `initialize` in a proof package runs in container B
   under the archive, but on a reader's `lax certify --run` it runs in their
   `lake`. The F1 ban closes this as a side effect; if `initialize` is ever
   admitted, the reader-side run needs the same containment.
