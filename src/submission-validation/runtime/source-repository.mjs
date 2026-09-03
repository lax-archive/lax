import sourceRepositoryHosts from "./source-repository-hosts.json" with { type: "json" };

const hostNames = Object.keys(sourceRepositoryHosts).sort();

/** Defense-in-depth copy of the trusted source URL policy used before git runs. */
export function validateSourceRepositoryUrl(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 2_048 || /\p{Cc}/u.test(raw)) {
    throw new Error("repository must be a bounded canonical public HTTPS repository URL");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("repository is not a valid URL");
  }
  const hostname = url.hostname.toLowerCase();
  const policy = Object.hasOwn(sourceRepositoryHosts, hostname)
    ? sourceRepositoryHosts[hostname]
    : undefined;
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port !== ""
  ) throw new Error("repository must be a canonical public HTTPS repository URL");
  if (policy === undefined) {
    throw new Error(`repository host must be one of: ${hostNames.join(", ")}`);
  }
  const segments = url.pathname.slice(1).split("/");
  if (
    segments.some((segment) => !/^[A-Za-z0-9_.-]+$/u.test(segment)) ||
    segments.at(-1)?.endsWith(".git") === true ||
    segments.length < policy.minPathSegments ||
    (policy.maxPathSegments !== null && segments.length > policy.maxPathSegments) ||
    segments.some((segment) => policy.forbiddenSegments.includes(segment))
  ) throw new Error(`repository path is not valid for ${hostname}`);
  const canonical = `https://${hostname}/${segments.join("/")}`;
  if (raw !== canonical) throw new Error("repository URL is not in canonical form");
  return canonical;
}
