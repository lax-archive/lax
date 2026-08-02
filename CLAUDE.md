# Repository guidance

This repository owns the Lax CLI, GitHub issue control plane, authorization
and input validation, trusted `lax-database` mutation, Website rebuild
dispatch, and CLI release packaging.

Before changing it:

1. Read `README.md` and the workspace-level `lax repository and workflow overview.md`.
2. Treat `spec.md`, `spec_conceptdialect.md`, `lax.md`, and especially
   `spec-notes.md` as retained design inputs. Do not edit normative specs
   unless explicitly asked.
3. Never give a job that checks out or executes submission code a GitHub App
   private key, installation token, or Archive write permission.
4. Treat every event value, comment, owner pair, URL, SHA, and path as
   untrusted. Parse event JSON as data and repeat schema, issue-binding,
   numeric-owner, state, and stale-write checks in the trusted publisher.
5. `lax-database` is the database repository. Do not reintroduce `lax-db` in
   active code, workflow configuration, or user documentation.
6. Keep trusted workflow validation and local `lax build` on the shared
   `src/submission-validation/` phases. Local mode may omit only server-only
   fetching, mandatory replay, and publishable artifact creation.
7. The CLI authenticates through a GitHub App user access token (`ghu_`), not
   an OAuth App token or PAT. App private keys and installation tokens exist
   only in trusted workflow jobs.

Commands:

```sh
npm run build
npm test
npm run check
npm run lax -- --help
```

The pinned page-builder consumed by `lax serve` is assembled for release with
`page-builder:fetch`, `page-builder:package`, and `page-builder:verify`.
