# Creating and controlling a Lax submission

The authoritative control surface is one ordinary issue in
`lax-archive/lax`. Its number permanently determines the Archive id:
issue `#42` owns `lax-42`.

## 1. Log in and allocate the id

```sh
lax login
lax init my-submission --title "A concise submission title"
```

Login walks through the bundled Lax GitHub App's device flow; no App
configuration is required. Personal and generic OAuth tokens are not accepted.
The issue-opened workflow validates the title
and human GitHub identity, then
creates the three stub files in `lax-archive/lax-database`. Keep the issue
open; every later command is a new comment on it.

`lax init` also scaffolds `manifest.yaml`, `abstract.md`, `LICENSE`, and the
two Lean packages locally. Use `lax create` instead when only issue allocation
is wanted.

## 2. Manage owners

```sh
lax set-owners my-submission --new-list alice bob
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

`lax submit` derives the `lax-N` issue id from `manifest.yaml` and the
repository, commit, and folder from Git. It runs the local build first unless
an existing full build matches the exact clean commit and current local
Archive snapshot. Use `lax update` when an explicit source triple is
preferable.

The request is authenticated, previewed, and run through the credential-free
Lean validation pipeline. Successful validation uploads
`validation-report.json`, `generated-build-output.json`, and `capture.tar`.
The trusted publication job parses and cross-checks those files, repeats the
current owner/state/issue/dependency checks, promotes the exact capture to an
immutable `lax-database` release, and commits only the authoritative
`record.json` and `build-output.json`. It leaves `owner-list.json` untouched,
synchronizes the issue title to the accepted manifest title, and dispatches a
complete Website rebuild. A failed check creates no database commit.

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
/lax update {"repository":"https://github.com/alice/formalization","commit":"0123456789abcdef0123456789abcdef01234567","folder":"."}
/lax delete
/lax register
```

Whitespace before `/lax` is invalid, edits do not execute, and malformed or
unknown commands fail closed.

## 5. Other people's submissions

Submission is open to any GitHub account, and the Archive does not review
submitted code. Cloning or building another author's submission on your own
machine is at your own risk.
