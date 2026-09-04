// The maintainer gate, placed once and called at both trust boundaries: the
// route job before it parses arguments, and the trusted publisher again,
// credential-free, before any token is minted (trust rule 2). Nothing here
// reads GitHub; the inputs are the resolved actor and the record as loaded.
import { ADMIN_GITHUB_IDS } from "./constants.js";
import type { AdminVerb, GitHubIdentity, SubmissionState } from "./types.js";

/** Why `actor` may not issue maintainer commands, or undefined when they may. */
export function maintainerProblem(
  actor: GitHubIdentity,
  admins: ReadonlySet<number> = ADMIN_GITHUB_IDS,
): string | undefined {
  return admins.has(actor.githubId) ? undefined : `${actor.handle} is not an archive maintainer`;
}

/**
 * Why a maintainer verb cannot run against a record in `state`, or undefined
 * when it can. These are the lifecycle rules the admin form *keeps*: every
 * verb still needs something to act on — a source to revalidate, a
 * registration to undo, a record that is not already a tombstone.
 */
export function adminStateProblem(
  verb: AdminVerb,
  id: string,
  state: SubmissionState,
  hasSource: boolean,
): string | undefined {
  switch (verb) {
    case "revalidate":
      if (state !== "draft" && state !== "registered") {
        return `${id} is ${state} and has no validated source to revalidate`;
      }
      return hasSource ? undefined : `${id} is ${state} without a recorded source and cannot be revalidated`;
    case "reset-draft":
      return state === "registered"
        ? undefined
        : `${id} is ${state}; only a registered submission can be reset to draft`;
    case "delete":
      return state === "deleted" ? `${id} is already deleted` : undefined;
    case "owners":
      return state === "deleted" ? `${id} is deleted and its owner list is frozen` : undefined;
  }
}
