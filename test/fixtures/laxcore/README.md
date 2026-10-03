# Fixture LaxCore

`LaxCore.lean` is a verbatim copy of the single module of
[lax-archive/lax-core](https://github.com/lax-archive/lax-core) (the
`lax_statement` tag attribute with its validation hook), and `lakefile.toml`
the smallest package that builds it. `test/fake-laxcore.ts` turns the two
into a local git repository under the shared test cache, which the fast
suite pins through `LAX_LAXCORE_URL`/`LAX_LAXCORE_REV` exactly as it pins
the fake mathlib — so a spec-2 fake environment provisions its whole library
set, builds packages against it, and the inspector (stage 2 of
`axiomfree-plan.md`) can read the tag's entries from real oleans, without
any network.

Keep the module in step with the library's commit the first spec-2
environment pins; the fixture directory name carries a hash of these files,
so an edit here rebuilds the fixture repository on the next run.
