/**
 * The single home of the file names lax itself puts into a submission folder.
 *
 * The same set is enumerated by five rules that have to agree: the scaffold
 * gitignores them, `lax build` writes them, static validation refuses them
 * when they are committed and leaves them out of a paper compiled from the
 * submission root, and `lax doctor` names a committed one early. Written out
 * five times, the list drifts the moment a feature adds a name — the paper
 * layer added `paper.pdf` to three of the copies and `paper-web.tar` to one —
 * so the names live here and every rule reads them from one place.
 */

/** What a local build records about itself, beside the sources it describes. */
export const BUILD_OUTPUT = "build-output.json";

/**
 * The compiled paper and the derived web bundle, exported because `lax build`
 * writes both files itself: naming them there too would be the sixth copy of
 * this list, and the one that decides what the other five have to cover.
 */
export const PAPER_PDF = "paper.pdf";
export const PAPER_WEB_TAR = "paper-web.tar";

/**
 * A submission owns those two names only once its manifest declares a paper:
 * without one there is nothing to compile, and a `paper.pdf` an author
 * committed for their own reasons is not the archive's business.
 */
const PAPER_OUTPUTS = [PAPER_PDF, PAPER_WEB_TAR];

/** Lake's own manifest, written next to every `lakefile.toml` it resolves. */
const LAKE_MANIFEST = "lake-manifest.json";

/**
 * Lake's dependency redirection, which lax writes inside `.lake/` to point the
 * mathlib closure at the shared warm store. Generated on every build, and a
 * committed copy would redirect resolution itself.
 */
const LAKE_OVERRIDES = "package-overrides.json";

export const LAX_GENERATED_FILES: {
  readonly root: readonly string[];
  readonly paper: readonly string[];
  readonly anywhere: readonly string[];
  readonly buildTree: string;
} = {
  /** Everything `lax build` writes into the submission root. */
  root: [BUILD_OUTPUT, ...PAPER_OUTPUTS],
  /** The subset of `root` that a declared paper, and only it, reserves. */
  paper: PAPER_OUTPUTS,
  /**
   * Names that are generated wherever they appear, and are therefore matched
   * by basename rather than by path: lake writes its manifest and lax its
   * overrides once per package, and a build output can only ever be one.
   */
  anywhere: [BUILD_OUTPUT, LAKE_MANIFEST, LAKE_OVERRIDES],
  /** Lake's build tree — generated wholesale, committed by nobody. */
  buildTree: ".lake",
};

/**
 * The `.gitignore` a new submission starts with.
 *
 * Derived from the list above rather than typed out beside it, because the
 * failure mode of a stale ignore file is quiet and expensive: the build writes
 * a file nothing ignores, the worktree goes dirty, and `lax submit` refuses it
 * naming nothing the author edited. `package-overrides.json` needs no line of
 * its own — it lives inside the ignored build tree.
 */
export function generatedFilesGitignore(): string {
  return [...LAX_GENERATED_FILES.root, LAKE_MANIFEST, `${LAX_GENERATED_FILES.buildTree}/`]
    .map((line) => `${line}\n`)
    .join("");
}
