import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const api = process.env.UNBLUR_API_URL ?? "http://localhost:4000";

export default defineConfig({
  plugins: [tailwindcss()],
  server: { port: 5173, proxy: { "/api": api } },
  preview: { port: 5173, proxy: { "/api": api } },
  build: { chunkSizeWarningLimit: 900 },
});
