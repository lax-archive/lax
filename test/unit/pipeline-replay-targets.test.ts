// Decision 10 (axiomfree-plan.md): the trusted run replays the concept
// package under every spec and the proof package under spec 1 only — the
// judge covers a spec-2 record's edges and no standards check consumes
// Replay's output. Pinned here on the stage's own plan, because the fake
// runner cannot provision a spec-2 warm store in a unit test; the spec-2
// docker smoke's profile shows `replay concepts` and no `replay proofs`,
// and the host e2e covers the local `--replay` that replays both.

import { describe, expect, it } from "vitest";
import { replayTargets } from "../../src/submission-validation/pipeline.js";

describe("the trusted run's Replay plan", () => {
  it("replays both packages in spec 1 and the concept package alone in spec 2", () => {
    expect(replayTargets("both", 1)).toEqual(["concepts", "proofs"]);
    expect(replayTargets("both", 2)).toEqual(["concepts"]);
  });

  it("keeps the scope rule under both specs", () => {
    expect(replayTargets("concepts", 1)).toEqual(["concepts"]);
    expect(replayTargets("concepts", 2)).toEqual(["concepts"]);
    expect(replayTargets("proofs", 1)).toEqual(["proofs"]);
    // a proofs-only local scope in spec 2 has nothing the trusted run would replay
    expect(replayTargets("proofs", 2)).toEqual([]);
  });
});
