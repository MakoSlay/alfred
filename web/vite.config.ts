import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/dashboard/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:47321",
      "/ask": "http://127.0.0.1:47321",
      "/dashboard/state": "http://127.0.0.1:47321",
      "/dashboard/tts": "http://127.0.0.1:47321",
      "/dashboard/facts": "http://127.0.0.1:47321",
      "/dashboard/undo": "http://127.0.0.1:47321",
      "/tools": "http://127.0.0.1:47321",
      "/mute": "http://127.0.0.1:47321",
      "/unmute": "http://127.0.0.1:47321"
    }
  }
});
