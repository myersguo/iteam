import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER_URL = process.env.ITEAM_SERVER_URL || "http://127.0.0.1:4318";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target: SERVER_URL, changeOrigin: true, ws: true },
      "/auth": { target: SERVER_URL, changeOrigin: true }
    }
  }
});
