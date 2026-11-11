import { defineConfig } from "vite";

// dxtutor desktop frontend.
//
// Tauri serves the built `dist/` as the webview content. During `tauri dev`
// Vite runs on a fixed port so the Rust side can point the webview at it.
// `clearScreen: false` keeps the Rust compiler output visible in the terminal.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  // Monaco ships large worker chunks; raise the warning ceiling so the build
  // stays green without hiding genuinely oversized bundles.
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // Split the heavy vendors into their own long-lived chunks so the app
        // code can change without re-shipping Monaco/xterm, and so the browser
        // can fetch them in parallel. The Monaco language-service pieces that
        // load lazily (json mode/worker) stay in their own split chunks.
        manualChunks(id) {
          if (id.includes("node_modules/monaco-editor")) return "monaco";
          if (id.includes("node_modules/@xterm")) return "xterm";
          return undefined;
        },
      },
    },
  },
});
