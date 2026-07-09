import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "path";

const envPath = path.resolve(process.cwd(), "..", "..");

function normalizeBasePath(value?: string) {
  const raw = (value || "").trim();
  if (!raw || raw === "/") return "/";
  return "/" + raw.replace(/^\/+|\/+$/g, "") + "/";
}

export default defineConfig(({ mode }) => {
  const {
    APP_URL,
    DOCMOST_PUBLIC_PATH_PREFIX,
    FILE_UPLOAD_SIZE_LIMIT,
    FILE_IMPORT_SIZE_LIMIT,
    DRAWIO_URL,
    CLOUD,
    SUBDOMAIN_HOST,
    COLLAB_URL,
    BILLING_TRIAL_DAYS,
    POSTHOG_HOST,
    POSTHOG_KEY,
    SERVER_PROXY_URL,
  } = loadEnv(mode, envPath, "");
  const appUrl = process.env.APP_URL || APP_URL;
  const publicPathPrefix =
    process.env.DOCMOST_PUBLIC_PATH_PREFIX || DOCMOST_PUBLIC_PATH_PREFIX;
  const proxyTarget =
    process.env.SERVER_PROXY_URL || SERVER_PROXY_URL || appUrl;

  return {
    base: normalizeBasePath(publicPathPrefix),
    define: {
      "process.env": {
        APP_URL: appUrl,
        DOCMOST_PUBLIC_PATH_PREFIX: publicPathPrefix,
        FILE_UPLOAD_SIZE_LIMIT,
        FILE_IMPORT_SIZE_LIMIT,
        DRAWIO_URL,
        CLOUD,
        SUBDOMAIN_HOST,
        COLLAB_URL,
        BILLING_TRIAL_DAYS,
        POSTHOG_HOST,
        POSTHOG_KEY,
      },
      APP_VERSION: JSON.stringify(process.env.npm_package_version),
    },
    plugins: [react()],
    build: {
      rolldownOptions: {
        output: {
          advancedChunks: {
            groups: [
              {
                name: "vendor-mantine",
                test: /[\\/]node_modules[\\/]@mantine[\\/]/,
              },
            ],
          },
        },
      },
    },
    resolve: {
      alias: {
        "@": "/src",
      },
    },
    server: {
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: false,
        },
        "/socket.io": {
          target: proxyTarget,
          ws: true,
          rewriteWsOrigin: true,
        },
        "/collab": {
          target: proxyTarget,
          ws: true,
          rewriteWsOrigin: true,
        },
      },
    },
  };
});
