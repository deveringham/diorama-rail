// npm run bench -- layouts/x.json [--quality low,medium,high] [--frames 5] [--t 0]
//                 [--size 1280x720] [--cam x,y,z,tx,ty,tz] [--url http://localhost:5173]
// Renders a layout at each graphics preset in headless Chromium and prints the
// median time per frame, draw calls and triangles. The WebGL there is SwiftShader,
// a software rasteriser: a stand-in for a weak graphics chip, slow and a little
// noisy (±30% between runs), so compare presets within one run.

import { build, preview } from "vite";
import { chromium } from "playwright";
import { createServer } from "node:net";
import { resolve, relative, basename } from "node:path";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "../..");
const READY_TIMEOUT = 300_000;
const PRESETS = ["low", "medium", "high"];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    quality: { type: "string", default: PRESETS.join(",") },
    frames: { type: "string", default: "5" },
    t: { type: "string", default: "0" },
    size: { type: "string", default: "1280x720" },
    cam: { type: "string" },
    url: { type: "string" },
  },
});

// Runs in the page (as source text: tsx would wrap its inner functions in a helper the page lacks).
// What a frame draws: cull small things for this view, render, and wait for the pixels; the median of n.
const MEASURE = `(n) => {
  const dr = window.dr;
  const px = new Uint8Array(4);
  const frame = () => {
    const gl = dr.renderer.getContext();
    dr.view.view(dr.camera, dr.renderer.domElement.height);
    dr.renderer.render(dr.scene, dr.camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  };
  frame();
  frame();
  const ts = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    frame();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return { ms: ts[Math.floor(n / 2)], calls: dr.renderer.info.render.calls, triangles: dr.renderer.info.render.triangles };
}`;

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
  const [width, height] = values.size.split("x").map(Number);
  const qualities = values.quality.split(",");
  const frames = Number(values.frames);
  if (!existsSync(abs) || !(width > 0 && height > 0) || !qualities.every((q) => PRESETS.includes(q)) || !(frames >= 1)) {
    console.error("usage: bench <layout.json> [--quality low,medium,high] [--frames N] [--t s] [--size WxH] [--cam x,y,z,tx,ty,tz] [--url base]");
    return 1;
  }
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
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    console.log(`${basename(abs)} at ${width}×${height}, t=${values.t} s, ${values.cam ? `camera ${values.cam}` : "overview"}`);
    console.log("preset   ms/frame  draw calls  triangles");
    // Each preset in a fresh page, so nothing one leaves behind slows the next.
    for (const quality of qualities) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      page.on("pageerror", (e) => console.error("[page]", e.message));
      const q = new URLSearchParams({ layout: layoutParam, t: values.t, shot: "1", quality });
      if (values.cam) q.set("cam", values.cam);
      await page.goto(`${base.replace(/\/$/, "")}/?${q}`);
      await page.waitForFunction(() => window.__drReady === true, undefined, { timeout: READY_TIMEOUT, polling: 250 });
      const err = await page.evaluate(() => window.__drError);
      if (err) {
        console.error("layout did not build:", typeof err === "string" ? err : JSON.stringify(err, null, 2));
        return 1;
      }
      const r = (await page.evaluate(`(${MEASURE})(${frames})`)) as { ms: number; calls: number; triangles: number };
      console.log(`${quality.padEnd(8)} ${r.ms.toFixed(0).padStart(8)}  ${String(r.calls).padStart(10)}  ${(r.triangles / 1000).toFixed(0).padStart(8)}k`);
      await page.close();
    }
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
