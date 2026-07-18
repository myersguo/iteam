import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendUrl = process.env.ITEAM_URL || `http://127.0.0.1:${process.env.ITEAM_PORT || "4318"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": backendUrl,
      "/auth": backendUrl
    }
  }
});
