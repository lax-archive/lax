# Creating and controlling a Lax submission

The authoritative control surface is one ordinary issue in
`lax-archive/lax`. Its number permanently determines the Archive id:
issue `#42` owns `lax-42`.

## 1. Log in and allocate the id

```sh
npm install -g lax-archive
lax login
lax init my-submission
```

Login walks through the bundled Lax GitHub App's device flow; no App
configuration is required. Personal and generic OAuth tokens are not accepted.
The issue-opened workflow validates the title
and human GitHub identity, then
creates the three stub files in `lax-archive/lax-database`. Keep the issue
open; every later command is a new comment on it.

`lax init` also scaffolds `manifest.yaml`, `abstract.md`, `LICENSE`, and the
two Lean packages locally, then provisions mathlib immediately: it builds the
shared environment under `~/.lax/warm` when the machine has none yet
(downloads gigabytes, once per machine) and seeds the generated Lake files so
that even a bare `lake build` straight after init replays the shared store
instead of downloading and compiling mathlib inside the submission. The
submission title defaults to the folder name; pass `--title` to set one.

## 2. Manage owners

```sh
lax owners my-submission --new-list alice bob
```

This is a complete replacement, not an add/remove patch. The CLI resolves the
handles to immutable numeric GitHub ids. The acting owner must remain in the
new list.

## 3. Request an import

Push an immutable commit to a public GitHub repository, then submit its exact
source location:

```sh
lax build my-submission
git commit && git push
lax submit my-submission
```

`lax build` validates on your own machine with the host Lean toolchain
(`elan` and `lake`; no docker needed): it builds in place in the submission's
`concepts/` and `proofs/` folders — incremental across runs — streaming the
`lake` transcript, and on first use builds the shared mathlib environment
under `~/.lax/warm` once per machine. Pass `--replay` to also run the kernel
replay the trusted workflow performs.

`lax submit` derives the `lax-N` issue id from `manifest.yaml` and the
repository, commit, and folder from Git. It runs the local build first unless
an existing full build matches the exact clean commit and current local
Archive snapshot. When an explicit source triple is preferable, pass it to the
same command: `lax submit <issue|folder> --repository <url> --commit <sha>
--folder <path>`.

If submit's polling is interrupted — a dropped connection, a closed laptop,
Ctrl-C — nothing is lost: the workflow keeps running on GitHub, and
`lax submit --resume` in the same folder reattaches to it. Submit prints that
command itself whenever it loses contact with GitHub.

The request is authenticated, previewed, and run through the credential-free
Lean validation pipeline. Successful validation uploads
`validation-report.json`, `generated-build-output.json`, and `capture.tar`.
The trusted publication job parses and cross-checks those files, repeats the
current owner/state/issue/dependency checks, promotes the exact capture to an
digest-addressed ghcr artifact, and commits only the authoritative
`record.json` and `build-output.json`. It leaves `owner-list.json` untouched,
synchronizes the issue title to the accepted manifest title, and dispatches a
complete Website rebuild. A failed check creates no database commit.

### Depending on another submission: the chain workflow

Every cross-submission dependency is a `git` require pinned to an exact
commit. A `path` require is rejected: the only one a lakefile may carry is
the proof package's own concept package, spelled exactly
`{ name = "LaxN", path = "../concepts" }` in `proofs/lakefile.toml`.

So a chain `A -> B -> C` lands bottom-up, one full round trip per member:

```sh
# 1. C is self-contained: commit, push, submit it
lax submit c-submission
# 2. patch C's commit into B's lakefile, then commit, push, submit B
#    [[require]] name = "LaxC", git = "https://github.com/you/repo",
#                rev = "<C's commit>", subDir = "c-submission/concepts"
lax submit b-submission
# 3. the same for A against B's new commit
lax submit a-submission
```

The require's `rev` is the commit that was submitted, and `subDir` is that
submission's folder plus `concepts` or `proofs`. If a require names a triple
that is not the dependency's registered source, validation rejects it and
repeats this workflow in the error message.

While iterating locally you do not have to chain anything: two drafts in one
working tree can be pointed at each other through the lax-managed package
overrides, and only the final commits need the pins.

Honest caveat: the chain is not atomic. Each member is registered by its own
round trip, so a failure part way up leaves the members below it registered
for good while the top never lands. Registration is permanent, so start a
chain only once the lower members are ones you are willing to keep, and
prefer `lax build` (and `--replay`) on the whole chain before submitting any
of it.

## 4. Register or delete

```sh
lax register my-submission
lax delete my-submission
```

Both actions are permanent. Registration makes a record immutable. Deletion
is available only before registration; it removes accepted content while
retaining a three-file tombstone, owner audit context, and the issue binding,
so the id can never be reused. Both commands require typing the `lax-N` id;
automation may pass `--yes`.

Commands can also be posted manually as exact comments:

```text
/lax owners [{"githubId":583231,"handle":"alice"}]
/lax submit {"repository":"https://github.com/alice/formalization","commit":"0123456789abcdef0123456789abcdef01234567","folder":"."}
/lax delete
/lax register
```

Whitespace before `/lax` is invalid, edits do not execute, and malformed or
unknown commands fail closed.

## 5. Other people's submissions

Submission is open to any GitHub account, and the Archive does not review
submitted code. Cloning or building another author's submission on your own
machine is at your own risk.
