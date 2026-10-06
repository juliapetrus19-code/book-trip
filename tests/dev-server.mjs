// Local dev server: serves static files and runs /api/*.js exactly like Vercel's web-standard handlers.
// Usage: node tests/dev-server.mjs [port]   (env vars such as ANTHROPIC_API_KEY are passed through)
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 5600);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4", ".woff2": "font/woff2",
};

async function handleApi(req, res, url) {
  const name = url.pathname.replace(/^\/api\//, "").replace(/\/+$/, "");
  if (!/^[a-z0-9-]+$/.test(name)) { res.writeHead(404).end(); return; }
  let mod;
  try {
    mod = await import(pathToFileURL(join(ROOT, "api", name + ".js")).href + "?t=" + Date.now());
  } catch (err) {
    if (err.code === "ERR_MODULE_NOT_FOUND") { res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}'); return; }
    throw err;
  }
  const handler = mod[req.method] || (mod.default && mod.default.fetch ? mod.default.fetch.bind(mod.default) : null);
  if (!handler) { res.writeHead(405).end(); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", req.socket.remoteAddress || "127.0.0.1");
  const request = new Request(url.href, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
  const response = await handler(request);
  const outHeaders = {};
  response.headers.forEach((v, k) => { outHeaders[k] = v; });
  res.writeHead(response.status, outHeaders);
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
  }
  res.end();
}

async function handleStatic(req, res, url) {
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const st = await stat(file);
    if (st.isDirectory()) { res.writeHead(302, { location: url.pathname + "/" }).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await handleStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "server", message: String(err && err.message) }));
  }
});
server.listen(PORT, () => console.log(`BookTrip dev server: http://localhost:${PORT}`));
