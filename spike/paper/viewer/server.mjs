// Tiny static server for site/, with the strict CSP the real Lax paper page
// would carry (no inline scripts, no CDN, worker and fetch same-origin only).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("./site/", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".pdf": "application/pdf",
  ".map": "application/json",
};
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const path = join(ROOT, rel === "/" ? "index.html" : rel);
    if (!path.startsWith(ROOT)) throw new Error("escape");
    await stat(path);
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": MIME[extname(path)] || "application/octet-stream",
      "content-security-policy": CSP,
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});
const port = Number(process.argv[2] || 8123);
server.listen(port, "127.0.0.1", () => console.log("http://127.0.0.1:" + port + "/"));
