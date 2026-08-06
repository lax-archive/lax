// Pure planning logic for the database port driver (scripts/port-db/port.mjs).
//
// Everything here is a total function over plain data: no network, no gh, no
// filesystem. That is what makes the risky part of the port — the order in
// which records are re-validated, and the exact bytes of the `/lax update`
// comment — testable without touching production. The drift guards live in
// test/unit/port-db-plan.test.ts, which checks these formats against the real
// src/shared implementations rather than against a copy of them.

/** Mirror of SUBMISSION_ID_PATTERN in src/shared/constants.ts. */
export const SUBMISSION_ID_PATTERN = /^lax-([1-9][0-9]*)$/u;

/** Mirror of submissionIdForPackage in src/submission-validation/contracts.ts. */
export function submissionIdForPackage(name) {
  const base = name.endsWith("Proofs") ? name.slice(0, -"Proofs".length) : name;
  const match = /^Lax([1-9][0-9]*)$/u.exec(base);
  return match === null ? undefined : `lax-${match[1]}`;
}

export function issueNumberForId(id) {
  const match = SUBMISSION_ID_PATTERN.exec(id);
  if (match === null) throw new Error(`not a submission id: ${id}`);
  return Number(match[1]);
}

/**
 * The forward dependency edges of a record: the submissions whose packages it
 * requires. Despite the name, `requiredByConcepts`/`requiredByProofs` in
 * build-output.json are the packages *this* record's concepts/proofs packages
 * require — phases/resolution.ts recurses into them exactly this way.
 * Package names that are not Lax packages (mathlib and friends) drop out.
 */
export function dependencyIds(record) {
  const output = record.buildOutput ?? {};
  const names = [
    ...(Array.isArray(output.requiredByConcepts) ? output.requiredByConcepts : []),
    ...(Array.isArray(output.requiredByProofs) ? output.requiredByProofs : []),
  ].filter((name) => typeof name === "string");
  const ids = new Set();
  for (const name of names) {
    const id = submissionIdForPackage(name);
    if (id !== undefined && id !== record.id) ids.add(id);
  }
  return [...ids].sort(compareIds);
}

/** Numeric order on submission ids, so lax-9 sorts before lax-10. */
export function compareIds(left, right) {
  return issueNumberForId(left) - issueNumberForId(right);
}

/**
 * Why a record is not portable. `init` records are stubs with no source triple
 * and nothing to re-validate; `registered` records are immutable and a `/lax
 * update` against one is rejected by the route job (and would be a loud
 * mistake, not a no-op); `deleted` ids are retired.
 */
export function skipReason(record) {
  if (record.state === "init") return "init stub: no source triple to re-validate";
  if (record.state === "registered") return "REGISTERED: immutable; /lax update would be rejected";
  if (record.state === "deleted") return "deleted: the id is retired";
  if (record.state !== "draft") return `unknown state ${JSON.stringify(record.state)}`;
  if (record.source === undefined) return "draft without a source triple";
  return undefined;
}

/**
 * Deterministic dependency-first order over the portable records.
 *
 * Records are sorted by (depth, numeric id), where depth is the longest path
 * to a record with no in-scope dependencies. Because depth(x) is strictly
 * greater than the depth of every dependency of x, this is a valid topological
 * order; because ties break on the numeric id, it is the same order on every
 * run. Grouping by depth also makes the plan readable: everything at depth 0
 * can be ported without any other port having happened first.
 *
 * Dependencies that are not portable themselves (an `init` stub, a missing
 * record) are reported per record rather than silently dropped: a dependent
 * whose dependency never gets a ghcr capture cannot resolve.
 *
 * A cycle is a hard error — the archive cannot contain one (resolution.ts
 * rejects it), so finding one means the data is corrupt.
 */
export function planOrder(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const portable = records.filter((record) => skipReason(record) === undefined);
  const inScope = new Set(portable.map((record) => record.id));

  const edges = new Map();
  const unportableDependencies = new Map();
  for (const record of portable) {
    const all = dependencyIds(record);
    edges.set(record.id, all.filter((id) => inScope.has(id)));
    const blocked = all.filter((id) => !inScope.has(id));
    if (blocked.length > 0) {
      unportableDependencies.set(
        record.id,
        blocked.map((id) => `${id} (${byId.has(id) ? skipReason(byId.get(id)) : "no such record"})`),
      );
    }
  }

  const depth = new Map();
  const state = new Map(); // undefined | "open" | "done"
  const compute = (id, trail) => {
    if (state.get(id) === "done") return depth.get(id);
    if (state.get(id) === "open") {
      const cycle = [...trail.slice(trail.indexOf(id)), id].join(" -> ");
      throw new Error(`dependency cycle in the database: ${cycle}`);
    }
    state.set(id, "open");
    let value = 0;
    for (const dependency of edges.get(id) ?? []) {
      value = Math.max(value, compute(dependency, [...trail, id]) + 1);
    }
    state.set(id, "done");
    depth.set(id, value);
    return value;
  };
  for (const record of portable) compute(record.id, []);

  const order = portable
    .map((record) => record.id)
    .sort((left, right) => depth.get(left) - depth.get(right) || compareIds(left, right));

  const skipped = records
    .filter((record) => skipReason(record) !== undefined)
    .map((record) => ({ id: record.id, state: record.state, reason: skipReason(record) }))
    .sort((left, right) => compareIds(left.id, right.id));

  return {
    order,
    depth,
    dependencies: edges,
    unportableDependencies,
    skipped,
  };
}

/**
 * The `/lax update` comment body. The exact accepted syntax is `/lax update`
 * followed by whitespace and the source triple as JSON with exactly the keys
 * repository, commit, folder (src/shared/commands.ts parseCommand ->
 * validateSource). Porting a record means replaying its *own* recorded triple:
 * the source does not change, only the pipeline that validates it.
 */
export function updateCommandBody(source) {
  for (const key of ["repository", "commit", "folder"]) {
    if (typeof source?.[key] !== "string" || source[key] === "") {
      throw new Error(`source triple is missing ${key}`);
    }
  }
  const triple = {
    repository: source.repository,
    commit: source.commit,
    folder: source.folder,
  };
  return `/lax update ${JSON.stringify(triple)}`;
}

/**
 * The correlation markers of src/shared/workflow-comments.ts. The control
 * plane posts its terminal comment carrying the result marker for the comment
 * id that triggered it, and annotates the triggering comment itself with the
 * workflow-run marker. Matching on those, not on comment order or text, is how
 * the CLI's follow logic correlates too.
 */
export function resultMarker(commentId) {
  return `<!-- lax-result-comment-id:${commentId} -->`;
}

export function hasResultMarker(body, commentId) {
  return typeof body === "string" && body.includes(resultMarker(commentId));
}

// GITHUB_ACTIONS_BOT_ID / GITHUB_ACTIONS_BOT_LOGIN in src/shared/constants.ts.
const GITHUB_ACTIONS_BOT_ID = 41_898_282;
const GITHUB_ACTIONS_BOT_LOGIN = "github-actions[bot]";

/**
 * Anyone who can comment on the issue can write our result marker into a
 * comment, so a marker only counts when the Actions bot wrote it (or when it
 * is on our own comment, which the route job annotates in place). Same rule as
 * matchComments in src/cli/follow.ts.
 */
export function isActionsBot(user) {
  return (
    user?.id === GITHUB_ACTIONS_BOT_ID &&
    user.login === GITHUB_ACTIONS_BOT_LOGIN &&
    user.type === "Bot"
  );
}

export function parseRunId(body) {
  const match = /<!-- lax-workflow-run-id:([0-9]+) -->/u.exec(typeof body === "string" ? body : "");
  return match === null ? undefined : match[1];
}

/** Strip the hidden markers so a result comment can be printed to a terminal. */
export function visibleComment(body) {
  return String(body ?? "")
    .split("\n")
    .filter((line) => !/^<!-- lax-[a-z-]+:[^>]+ -->$/u.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * The heaviest immediate child of the profile root — the phase that dominated
 * the run. The profile is the span tree of src/shared/profile.ts:
 * `{name, ms, children[]}`.
 */
export function heaviestPhase(root) {
  const children = Array.isArray(root?.children) ? root.children : [];
  let heaviest;
  for (const child of children) {
    if (typeof child?.ms !== "number") continue;
    if (heaviest === undefined || child.ms > heaviest.ms) heaviest = { name: child.name, ms: child.ms };
  }
  return heaviest;
}

/**
 * Peak resident memory, in bytes, if the pipeline recorded it. The field is
 * being added to the profile concurrently with this driver, so it is looked up
 * by shape rather than by a fixed path: any `*peak*bytes`-ish numeric key
 * anywhere in the document counts, and the largest wins. Absent is fine.
 */
export function peakMemoryBytes(value) {
  const interesting = /^(peak|max)(Memory|Rss|Resident)?(Bytes)?$|^peak.*Bytes$|^(maxRss|peakRss)/u;
  let peak;
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, entry] of Object.entries(node)) {
      if (typeof entry === "number" && Number.isFinite(entry) && interesting.test(key)) {
        peak = peak === undefined ? entry : Math.max(peak, entry);
      }
      walk(entry);
    }
  };
  walk(value);
  return peak;
}

export function formatMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  if (ms >= 90_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 10_000) return `${(ms / 1_000).toFixed(0)}s`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms.toFixed(0)}ms`;
}

export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${gib.toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}

const COLUMNS = [
  ["id", (row) => row.id],
  ["prior state", (row) => row.priorState ?? ""],
  ["result", (row) => row.result],
  ["wall clock", (row) => formatMs(row.wallMs)],
  ["heaviest phase", (row) => (row.heaviestPhase === undefined
    ? ""
    : `${row.heaviestPhase.name} ${formatMs(row.heaviestPhase.ms)}`)],
  ["peak memory", (row) => formatBytes(row.peakMemoryBytes)],
  ["capture digest", (row) => (row.captureDigest === undefined ? "" : row.captureDigest.slice(0, 16))],
];

/** The summary table, as fixed-width text for the terminal. */
export function formatTable(rows) {
  const header = COLUMNS.map(([name]) => name);
  const body = rows.map((row) => COLUMNS.map(([, read]) => String(read(row) ?? "")));
  const widths = header.map((name, index) =>
    Math.max(name.length, ...body.map((cells) => cells[index].length), 0),
  );
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

/** The same summary as markdown, for the written report. */
export function formatMarkdown(report) {
  const lines = [
    `# lax-database port — ${report.startedAt}`,
    "",
    `- database: \`${report.databaseRepository}\``,
    `- control: \`${report.controlRepository}\``,
    `- mode: ${report.mode}`,
    `- ported: ${report.rows.filter((row) => row.result === "ok").length}/${report.rows.length}`,
    "",
    `| ${COLUMNS.map(([name]) => name).join(" | ")} |`,
    `| ${COLUMNS.map(() => "---").join(" | ")} |`,
    ...report.rows.map(
      (row) => `| ${COLUMNS.map(([, read]) => String(read(row) ?? "").replaceAll("|", "\\|")).join(" | ")} |`,
    ),
  ];
  if (report.skipped.length > 0) {
    lines.push("", "## Skipped", "");
    for (const entry of report.skipped) lines.push(`- \`${entry.id}\` (${entry.state}) — ${entry.reason}`);
  }
  const failures = report.rows.filter((row) => row.result !== "ok");
  if (failures.length > 0) {
    lines.push("", "## Failures", "");
    for (const row of failures) {
      lines.push(`### ${row.id}`, "", `- issue: ${row.issueUrl ?? ""}`, `- run: ${row.runUrl ?? ""}`, "");
      if (row.detail !== undefined && row.detail !== "") lines.push("```", row.detail, "```", "");
    }
  }
  return `${lines.join("\n")}\n`;
}
