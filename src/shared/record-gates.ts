// The record gates every trusted publisher repeats at the CAS snapshot,
// placed once and called from each `validateCurrent`: the record still
// exists and still binds to the issue the command came from, the canonical
// actor may still act on it (an owner for the author form, a maintainer for
// the admin form), its state still admits the verb, and the files the verb
// reads are the files the route job read. Nothing here reads GitHub; the
// inputs are the parsed request and the record as loaded at the snapshot the
// non-forced ref update commits against, so every check runs credential-free
// before any token is minted (trust rule 2). What genuinely differs per verb
// — which digests it reads — arrives as an option; the wording does not.
import { adminStateProblem, maintainerProblem } from "./admin.js";
import { samePreconditions, type LoadedSubmission } from "./archive.js";
import {
  isAdminCommand,
  isAdminVerb,
  type FilePreconditions,
  type PublishRequest,
  type SubmissionState,
} from "./types.js";
import { ValidationError } from "./validation.js";

/** The states in which an author (not a maintainer) may still change a record. */
export const AUTHOR_MUTABLE_STATES: readonly SubmissionState[] = ["init", "draft"];

export interface RecordGateOptions {
  /** States the author form still admits; the maintainer form's are adminStateProblem's. */
  authorStates: readonly SubmissionState[];
  /** The digests this verb reads, which must be the ones the route job read. */
  relevantPreconditions: ReadonlyArray<keyof FilePreconditions>;
  /** Maintainer ids; injectable for tests, ADMIN_GITHUB_IDS in production. */
  admins: ReadonlySet<number>;
}

/** The record a mutation acts on, or the one refusal every mutating verb shares. */
export function requireCurrentRecord(
  id: string,
  current: LoadedSubmission | undefined,
): LoadedSubmission {
  if (current === undefined) throw new ValidationError(`${id} no longer exists in lax-database`);
  return current;
}

/**
 * Why `request` may not mutate `current` as it stands at the snapshot, in the
 * order the route job asked the same questions: issue binding, then who may
 * act and whether the state admits the verb, then whether the files changed
 * after validation. Empty when the mutation may proceed.
 */
export function recordGateProblems(
  request: PublishRequest,
  current: LoadedSubmission,
  options: RecordGateOptions,
): string[] {
  const problems: string[] = [];
  if (
    current.files.buildOutput.issue.repositoryId !== request.issue.repositoryId ||
    current.files.buildOutput.issue.number !== request.issue.number
  ) {
    problems.push(`${request.id} no longer has the expected issue binding`);
  }
  if (isAdminCommand(request.command)) {
    // The route job's maintainer and lifecycle gates, repeated on the
    // canonical actor and the current record; ownership does not apply —
    // recovering an orphaned record is the point of the maintainer form.
    const maintainer = maintainerProblem(request.actor, options.admins);
    if (maintainer !== undefined) problems.push(maintainer);
    if (!isAdminVerb(request.action)) {
      problems.push(`${request.action} has no maintainer form`);
    } else {
      const state = adminStateProblem(
        request.action,
        request.id,
        current.files.record.state,
        current.files.record.source !== undefined,
      );
      if (state !== undefined) problems.push(state);
    }
  } else {
    if (!current.files.ownerList.owners.some((owner) => owner.githubId === request.actor.githubId)) {
      problems.push(`${request.actor.handle} is no longer an owner of ${request.id}`);
    }
    if (!options.authorStates.includes(current.files.record.state)) {
      problems.push(`${request.id} is now ${current.files.record.state}`);
    }
  }
  if (
    request.preconditions === undefined ||
    !samePreconditions(current.preconditions, request.preconditions, [...options.relevantPreconditions])
  ) {
    problems.push(`${request.id} changed after validation; submit a new command comment`);
  }
  return problems;
}
