// Writes web/dist: the static site, the config, the recorded fixture, a verbatim copy of the compiled simulator, and
// the page's Content-Security-Policy (built from config.js, so it allows exactly the hosts the page is configured to read).
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const simDist = join(root, "..", "sim", "dist", "src");

export function cspFor(config) {
  const connect = ["'self'"];
  if (config.fixture === null) {
    for (const url of [config.rpcUrl, config.indexerUrl]) {
      const u = new URL(url);
      if (u.protocol !== "https:") throw new Error(`config: ${url} must be https`);
      connect.push(u.origin);
    }
  }
  return ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", `connect-src ${[...new Set(connect)].join(" ")}`, "base-uri 'none'", "form-action 'none'"].join("; ");
}

export async function build() {
  const { config } = await import(pathToFileURL(join(root, "config.js")).href);
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await cp(join(root, "site"), dist, { recursive: true });
  await cp(join(root, "config.js"), join(dist, "config.js"));
  if (config.fixture !== null) await cp(join(root, "fixtures"), join(dist, "fixtures"), { recursive: true });
  await mkdir(join(dist, "vendor", "sim"), { recursive: true });
  const simFiles = (await readdir(simDist)).filter((f) => f.endsWith(".js"));
  if (!simFiles.includes("sim.js")) throw new Error("sim/dist is missing: run `make -C sim build` first");
  for (const f of simFiles) await cp(join(simDist, f), join(dist, "vendor", "sim", f));
  const html = await readFile(join(dist, "index.html"), "utf8");
  await writeFile(join(dist, "index.html"), html.replace("__CSP__", cspFor(config)));
  return dist;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(`built ${await build()}`);
