import type { PublisherArchive } from "./publisher.js";
import { CONTROL_REPOSITORY } from "./constants.js";
import { repositoryPath } from "./github.js";
import type { PublishRequest } from "./types.js";
import { isObject, normalizeTitle, ValidationError } from "./validation.js";

/**
 * Sync from the current archive, never a job's potentially obsolete accepted
 * title. A concurrent publication during PATCH is detected afterwards and
 * repaired. Website dispatches already rebuild the latest database head.
 */
export async function synchronizeSubmissionTitle(
  archive: Pick<PublisherArchive, "load">,
  github: { request(method: "PATCH", path: string, body: { title: string }): Promise<unknown> },
  request: Pick<PublishRequest, "id" | "issue">,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await archive.load(request.id);
    if (current === undefined || current.files.record.state === "deleted") return;
    if (JSON.stringify(current.files.buildOutput.issue) !== JSON.stringify(request.issue)) {
      throw new ValidationError("issue binding changed before title synchronization");
    }
    const inputs = current.files.buildOutput.inputs;
    if (!isObject(inputs) || !isObject(inputs.manifest) || typeof inputs.manifest.title !== "string") {
      throw new ValidationError("published build output has no title to synchronize");
    }
    const title = normalizeTitle(inputs.manifest.title);
    await github.request("PATCH", `${repositoryPath(CONTROL_REPOSITORY)}/issues/${request.issue.number}`, { title });
    const latest = await archive.load(request.id);
    if (latest === undefined || latest.files.record.state === "deleted" ||
      latest.preconditions.buildOutput === current.preconditions.buildOutput) return;
  }
  throw new Error("the archive kept changing during issue title synchronization");
}
