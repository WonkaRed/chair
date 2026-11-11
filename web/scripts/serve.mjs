// Serves web/dist on loopback for `make serve`. Plain static files: any host does the same job.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, sep } from "node:path";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
const port = Number(process.env.PORT ?? 8080);

const server = createServer(async (req, res) => {
  let path;
  try {
    path = normalize(join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  } catch {
    return void res.writeHead(400).end();
  }
  const file = path.endsWith(sep) ? join(path, "index.html") : path;
  if (!file.startsWith(dist + sep)) return void res.writeHead(403).end();
  let body;
  try {
    body = await readFile(file);
  } catch {
    return void res.writeHead(404).end("not found");
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
});

server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`port ${port} is already in use; pick another one: PORT=${port + 1} make -C web serve`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
