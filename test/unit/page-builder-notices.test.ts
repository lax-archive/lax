// The aggregation-with-notices obligation on the packaged page-builder
// (paper-web-plan.md, "Risks"): the vendored tarball must name every
// third-party component it carries and refuse to package vendored code
// whose license text is missing. The manifest is a pure function of the
// extracted tree, so both `page-builder:package` (which writes it) and
// `page-builder:verify` (which re-derives and compares it) share it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOTICES_FILENAME, thirdPartyNotices } from "../../src/cli/deployment/shared.js";

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lax-notices-"));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

describe("the page-builder third-party notices", () => {
  it("names the manifest file the packaged tarball carries at top level", () => {
    expect(NOTICES_FILENAME).toBe("THIRD-PARTY-NOTICES.txt");
  });

  it("lists only the components the pinned (pre-paper) revision vendors", () => {
    const root = tree({
      "assets/site/GUST-FONT-LICENSE.txt": "GUST Font License v1.0",
      "assets/site/fonts/LM-regular.woff2": "font bytes",
      "assets/site/style.css": "body {}",
    });
    const notices = thirdPartyNotices(root);
    expect(notices).toContain("Latin Modern fonts");
    expect(notices).toContain("GUST Font License (assets/site/GUST-FONT-LICENSE.txt)");
    expect(notices).not.toContain("pdf.js");
    expect(notices).not.toContain("ReflowTeX");
  });

  it("lists pdf.js and the ReflowTeX viewer once the tree vendors them", () => {
    const root = tree({
      "assets/site/GUST-FONT-LICENSE.txt": "GUST Font License v1.0",
      "assets/site/fonts/LM-regular.woff2": "font bytes",
      "assets/site/pdfjs/LICENSE.txt": "Apache License",
      "assets/site/pdfjs/VERSION.txt": "5.6.205\n",
      "assets/site/pdfjs/pdf.min.mjs": "// pdf.js",
      "assets/site/reflowtex/LICENSE.txt": "GNU AFFERO GENERAL PUBLIC LICENSE",
      "assets/site/reflowtex/latex-viewer.js": "// AGPL viewer, unminified",
    });
    const notices = thirdPartyNotices(root);
    expect(notices).toContain("- pdf.js 5.6.205");
    expect(notices).toContain("License: Apache-2.0 (assets/site/pdfjs/LICENSE.txt)");
    expect(notices).toContain("- ReflowTeX viewer");
    expect(notices).toContain("License: AGPL-3.0-or-later (assets/site/reflowtex/LICENSE.txt)");
    expect(notices).toContain("https://github.com/radek-p/reflowtex");
    expect(notices).toContain("Latin Modern fonts");
    // Deterministic: derived from the tree, not from the clock or ordering.
    expect(thirdPartyNotices(root)).toBe(notices);
  });

  it("refuses to describe a tree that vendors the viewer without its license", () => {
    const root = tree({
      "assets/site/reflowtex/latex-viewer.js": "// AGPL viewer",
    });
    expect(() => thirdPartyNotices(root)).toThrow(/ReflowTeX viewer.*without its.*license/su);
  });

  it("refuses vendored pdf.js without its license text", () => {
    const root = tree({
      "assets/site/pdfjs/pdf.min.mjs": "// pdf.js",
    });
    expect(() => thirdPartyNotices(root)).toThrow(/pdf\.js.*without its.*license/su);
  });
});
