/// <reference types="vitest/config" />
// Vite config plus a tiny plugin for layouts: serves layouts/*.json (and an
// index.json listing them) in dev and preview, answers unknown layout names with
// a 404 instead of the HTML fallback, serves any local .json for the screenshot
// CLI (/__layout?path=...), copies layouts into the build, and pushes a custom
// HMR event when a layout file changes so the page rebuilds without a reload.

import { defineConfig, type Plugin, type Connect } from "vite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

const LAYOUTS = resolve(import.meta.dirname, "layouts");

type Res = Parameters<Connect.NextHandleFunction>[1];

/** Names of the layouts in layouts/, without the .json extension. */
const layoutNames = () => readdirSync(LAYOUTS).filter((n) => n.endsWith(".json") && n !== "index.json").map((n) => n.slice(0, -5)).sort();

function sendJson(res: Res, body: string | Buffer, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

const layoutMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/__layout") {
    const file = url.searchParams.get("path") ?? "";
    if (isAbsolute(file) && file.endsWith(".json") && existsSync(file)) return sendJson(res, readFileSync(file));
    return sendJson(res, JSON.stringify({ error: `no such file: ${file}` }), 404);
  }
  if (url.pathname === "/layouts/index.json") return sendJson(res, JSON.stringify(layoutNames()));
  const m = /^\/layouts\/([\w.-]+)\.json$/.exec(url.pathname);
  if (m && existsSync(resolve(LAYOUTS, `${m[1]}.json`))) return sendJson(res, readFileSync(resolve(LAYOUTS, `${m[1]}.json`)));
  // Without this, Vite's SPA fallback would answer with index.html and a 200.
  if (m) return sendJson(res, JSON.stringify({ error: `no layout '${m[1]}'`, available: layoutNames() }), 404);
  next();
};

function layouts(): Plugin {
  return {
    name: "diorama-layouts",
    configureServer(server) {
      server.middlewares.use(layoutMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(layoutMiddleware);
    },
    handleHotUpdate({ file, server }) {
      if (!file.endsWith(".json") || relative(LAYOUTS, file).startsWith("..")) return;
      server.ws.send({ type: "custom", event: "dr:layout", data: { file: relative(server.config.root, file) } });
      return [];
    },
    generateBundle() {
      for (const name of layoutNames()) {
        this.emitFile({ type: "asset", fileName: `layouts/${name}.json`, source: readFileSync(resolve(LAYOUTS, `${name}.json`)) });
      }
      this.emitFile({ type: "asset", fileName: "layouts/index.json", source: JSON.stringify(layoutNames()) });
    },
  };
}

export default defineConfig({
  plugins: [layouts()],
  build: { chunkSizeWarningLimit: 1200 },
  test: { testTimeout: 60000 },
});
