import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const [rawUrl, destination] = process.argv.slice(2);
if (rawUrl === undefined || destination === undefined || !path.isAbsolute(destination)) process.exit(2);
let url;
try {
  url = new URL(rawUrl);
} catch {
  console.error("capture URL is invalid");
  process.exit(2);
}
const allowedHosts = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.username || url.password) {
  console.error("capture URL is not an allowed public HTTPS location");
  process.exit(2);
}
await mkdir(path.dirname(destination), { recursive: true });
let response;
for (let redirects = 0; redirects <= 5; redirects += 1) {
  response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10 * 60_000) });
  if (![301, 302, 303, 307, 308].includes(response.status)) break;
  const location = response.headers.get("location");
  if (location === null || redirects === 5) {
    console.error("capture download has an invalid redirect chain");
    process.exit(1);
  }
  url = new URL(location, url);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.username || url.password) {
    console.error("capture redirect leaves the allowed public HTTPS locations");
    process.exit(1);
  }
}
if (response === undefined) process.exit(1);
if (!response.ok || response.body === null) {
  console.error(`capture download failed with HTTP ${response.status}`);
  process.exit(1);
}
const length = Number(response.headers.get("content-length") ?? "0");
if (length > 2 * 1024 * 1024 * 1024) {
  console.error("capture exceeds 2 GiB");
  process.exit(1);
}
let bytes = 0;
const limit = 2 * 1024 * 1024 * 1024;
const counter = new Transform({
  transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > limit ? new Error("capture exceeds 2 GiB") : null, chunk);
  },
});
await pipeline(
  Readable.fromWeb(response.body),
  counter,
  createWriteStream(destination, { flags: "wx", mode: 0o600 }),
);
