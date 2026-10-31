import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const modulePath = id.replaceAll("\\", "/");
          // Keep the JSX runtime and CJS helpers out of lazy Markdown chunks.
          if (
            modulePath.includes("commonjsHelpers") ||
            /\/node_modules\/(react|react-dom|scheduler)\//.test(modulePath)
          )
            return "react";
          if (/\/node_modules\/(react-markdown|remark-gfm)\//.test(modulePath))
            return "markdown";
          if (modulePath.includes("/node_modules/rehype-highlight/"))
            return "syntax";
          if (
            /\/node_modules\/(remark-math|rehype-katex|katex)\//.test(
              modulePath,
            )
          )
            return "math";
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        // Preserve the browser-facing host so the API can validate Origin.
        changeOrigin: false,
      },
    },
  },
});
