/// <reference types="vitest/config" />
// Vite config plus a tiny plugin for layouts: serves layouts/*.json in dev and
// preview, serves any local .json for the screenshot CLI (/__layout?path=...),
// copies layouts into the build, and pushes a custom HMR event when a layout
// file changes so the page rebuilds the world without a full reload.

import { defineConfig, type Plugin, type Connect } from "vite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

const LAYOUTS = resolve(import.meta.dirname, "layouts");

function sendJson(res: Parameters<Connect.NextHandleFunction>[1], file: string): void {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(readFileSync(file));
}

const layoutMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/__layout") {
    const file = url.searchParams.get("path") ?? "";
    if (isAbsolute(file) && file.endsWith(".json") && existsSync(file)) return sendJson(res, file);
    res.statusCode = 404;
    return res.end();
  }
  const m = /^\/layouts\/([\w.-]+\.json)$/.exec(url.pathname);
  if (m && existsSync(resolve(LAYOUTS, m[1]))) return sendJson(res, resolve(LAYOUTS, m[1]));
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
      for (const f of readdirSync(LAYOUTS).filter((n) => n.endsWith(".json"))) {
        this.emitFile({ type: "asset", fileName: `layouts/${f}`, source: readFileSync(resolve(LAYOUTS, f)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [layouts()],
  build: { chunkSizeWarningLimit: 1200 },
  test: { testTimeout: 60000 },
});
