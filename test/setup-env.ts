// Runs in every fork before any test module is imported: point the archive's
// mathlib pin at the fake (see fake-mathlib.ts), and the LaxCore pin of a
// spec-2 fake environment at the fixture LaxCore (fake-laxcore.ts). LAX_E2E
// runs keep the real pins — combine LAX_E2E=1 only with the e2e test files,
// or every fast test will download real mathlib.
import { fakeLaxCore } from "./fake-laxcore.js";
import { fakeMathlib } from "./fake-mathlib.js";
import { putToolchainOnPath } from "./paths.js";

if (process.env.LAX_E2E !== "1") {
  const { url, rev } = fakeMathlib();
  process.env.LAX_MATHLIB_URL = url;
  process.env.LAX_MATHLIB_REV = rev;
  const laxCore = fakeLaxCore();
  process.env.LAX_LAXCORE_URL = laxCore.url;
  process.env.LAX_LAXCORE_REV = laxCore.rev;
}
putToolchainOnPath();
