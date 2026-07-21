import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv, type Plugin } from "vite";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 5184;
const LOCAL_VRM_ROUTE = "/__companion-local/vrm";
const MAX_LOCAL_VRM_BYTES = 100 * 1024 * 1024;
const STAGE_ROOT = fileURLToPath(new URL(".", import.meta.url));

function localVrmPlugin(configuredPath: string | undefined): Plugin {
  return {
    name: "companion-private-vrm-development-asset",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split(/[?#]/u, 1)[0];
        if (path !== LOCAL_VRM_ROUTE) return next();
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.end("method_not_allowed");
          return;
        }
        if (!configuredPath) {
          response.statusCode = 404;
          response.end("local_vrm_not_configured");
          return;
        }

        const assetPath = resolve(configuredPath);
        if (!assetPath.toLowerCase().endsWith(".vrm") || !existsSync(assetPath)) {
          response.statusCode = 404;
          response.end("local_vrm_unavailable");
          return;
        }

        const size = statSync(assetPath).size;
        if (size > MAX_LOCAL_VRM_BYTES) {
          response.statusCode = 413;
          response.end("local_vrm_too_large");
          return;
        }

        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "model/gltf-binary");
        createReadStream(assetPath)
          .on("error", () => {
            if (!response.headersSent) response.statusCode = 500;
            response.end("local_vrm_read_failed");
          })
          .pipe(response);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const local = loadEnv(mode, STAGE_ROOT, "COMPANION_");
  const configuredPort = Number.parseInt(
    local.COMPANION_STAGE_PORT ?? process.env.COMPANION_STAGE_PORT ?? `${DEFAULT_PORT}`,
    10,
  );
  const port =
    Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65_536
      ? configuredPort
      : DEFAULT_PORT;
  return {
    root: STAGE_ROOT,
    plugins: [vue(), localVrmPlugin(local.COMPANION_VRM_PATH)],
    server: {
      host: HOST,
      port,
      strictPort: true,
      cors: false,
      fs: { strict: true },
      headers: {
        "Content-Security-Policy": `default-src 'self'; connect-src 'self' blob: ws://127.0.0.1:${port}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; media-src 'self' blob:`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
    preview: { host: HOST, port, strictPort: true },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
