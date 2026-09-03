# Creating and controlling a Lax submission

The submission id is a random six-digit value such as `lax-123456`, stored in
`manifest.yaml`. An issue in `lax-archive/lax` becomes the authoritative
control surface when the first authenticated update permanently binds that id
to the issue number.

## 1. Initialize locally

```sh
lax init my-submission --title "A concise submission title"
```

`lax init` needs no GitHub login or network access. It generates the id and
scaffolds `manifest.yaml`, `abstract.md`, `LICENSE`, and the two Lean packages
locally. The id has six digits and never starts with zero.

## 2. Manage owners

```sh
lax set-owners my-submission --new-list alice bob
```

Before an issue exists, the handles are stored provisionally in
`manifest.yaml`. The CLI checks them through GitHub's public API; if that check
is unavailable or rate-limited it warns and defers verification. The first
authenticated update resolves every provisional handle again with the user
token and synchronizes the resulting numeric GitHub identities. After an issue
exists, this command is a complete replacement and the acting owner must remain
in the new list.

## 3. Request an import

Push an immutable commit to a public repository on GitHub, GitLab.com,
Codeberg, or Bitbucket Cloud, then submit its exact source location. Lax still
uses your GitHub account for authentication and ownership regardless of the
source host:

```sh
lax login
lax build my-submission
git commit && git push
lax submit my-submission
# Commit and push the issue field added to manifest.yaml, then:
lax submit my-submission
```

The first `lax submit` (or explicit `lax update`) validates the six-digit id and
generated package identity, checks that the id is unused, creates its issue,
stores the issue binding in `manifest.yaml`, synchronizes provisional owners,
and stops before uploading source. If the id already exists, the CLI rekeys the
local files and asks you to commit them before retrying. Once an issue exists,
the id cannot be rebound: every command carries the manifest id and the server
checks it against the Archive's issue binding.

Existing submissions from the pre-migration Archive snapshot may initially
lack `issue`. The CLI recognizes only that frozen set, verifies the historical
issue-number binding against the Archive, writes it into `manifest.yaml`, and
asks you to commit before retrying. During the rollout, an issue created by the
previous CLI is accepted only when its body exactly matches that CLI's control
issue text; its issue-derived manifest remains valid for that route.

`lax submit` derives the id and issue binding from `manifest.yaml` and the
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
/lax owners lax-123456 [{"githubId":583231,"handle":"alice"}]
/lax update lax-123456 {"repository":"https://github.com/alice/formalization","commit":"0123456789abcdef0123456789abcdef01234567","folder":"."}
/lax delete lax-123456
/lax register lax-123456
```

Whitespace before `/lax` is invalid, edits do not execute, and malformed or
unknown commands fail closed.
