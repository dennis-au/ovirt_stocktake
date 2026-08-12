import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "frontend",
  plugins: [react()],
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000"
    }
  },
  preview: {
    port: 4173
  },
  test: {
    environment: "node",
    include: ["../tests/**/*.test.ts"]
  }
});
