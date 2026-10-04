// npm run screenshot -- layouts/x.json [--out shot.png] [--t 120] [--view overview|top|follow]
//                      [--size 1600x1000] [--url http://localhost:5173] [--cam x,y,z,tx,ty,tz]
//                      [--object id[,id...]|all] [--season summer|autumn|winter]
// Builds and previews the app on a free port (or reuses a running server via --url),
// renders the layout (or, with --object, just those scenery objects) in headless
// Chromium (SwiftShader WebGL) and saves a PNG.

import { build, preview } from "vite";
import { chromium } from "playwright";
import { createServer } from "node:net";
import { resolve, relative, basename } from "node:path";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "../..");
const READY_TIMEOUT = 240_000;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "shot.png" },
    t: { type: "string", default: "0" },
    view: { type: "string", default: "overview" },
    size: { type: "string", default: "1600x1000" },
    url: { type: "string" },
    cam: { type: "string" },
    object: { type: "string" },
    season: { type: "string" },
  },
});

const freePort = () => new Promise<number>((ok, fail) => {
  const srv = createServer();
  srv.listen(0, () => {
    const addr = srv.address();
    srv.close(() => (addr && typeof addr === "object" ? ok(addr.port) : fail(new Error("no port"))));
  });
});

async function main(): Promise<number> {
  const file = positionals[0] ?? "layouts/valley-loop.json";
  const abs = resolve(file);
  if (!existsSync(abs)) {
    console.error(`no such layout: ${file}`);
    return 1;
  }
  const [width, height] = values.size.split("x").map(Number);
  if (!["overview", "top", "follow"].includes(values.view) || !(width > 0 && height > 0)) {
    console.error("usage: screenshot <layout.json> [--out f.png] [--t s] [--view overview|top|follow] [--size WxH] [--url base]");
    return 1;
  }
  // Layouts in ./layouts load by name; anything else is served by the vite plugin's /__layout route.
  const inLayouts = relative(resolve(ROOT, "layouts"), abs) === basename(abs);
  const layoutParam = inLayouts ? basename(abs, ".json") : `/__layout?path=${encodeURIComponent(abs)}`;

  let base = values.url;
  let server: Awaited<ReturnType<typeof preview>> | null = null;
  if (!base) {
    await build({ root: ROOT, logLevel: "warn" });
    const port = await freePort();
    server = await preview({ root: ROOT, preview: { port, strictPort: true, host: "127.0.0.1" }, logLevel: "warn" });
    base = `http://127.0.0.1:${port}`;
  }

  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on("console", (m) => { if (m.type() === "error") console.error("[page]", m.text()); });
    page.on("pageerror", (e) => console.error("[page]", e.message));
    const q = new URLSearchParams({ layout: layoutParam, t: values.t, view: values.view, shot: "1" });
    if (values.cam) q.set("cam", values.cam);
    if (values.object) q.set("object", values.object === "all" ? "*" : values.object);
    if (values.season) q.set("season", values.season);
    await page.goto(`${base.replace(/\/$/, "")}/?${q}`);
    await page.waitForFunction(() => window.__drReady === true, undefined, { timeout: READY_TIMEOUT, polling: 250 });
    const err = await page.evaluate(() => window.__drError);
    if (err) {
      console.error(values.object ? "objects could not be previewed:" : "layout did not build:", typeof err === "string" ? err : JSON.stringify(err, null, 2));
      return 1;
    }
    await page.screenshot({ path: values.out });
    const stats = await page.evaluate(() => window.__drStats);
    console.log(`wrote ${values.out}${stats ? ` (${stats.calls} draw calls, ${(stats.triangles / 1000).toFixed(0)}k triangles)` : ""}`);
    return 0;
  } finally {
    await browser.close();
    await server?.close();
  }
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
