import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // The API validates Origin against the Host it was addressed by, so the
      // dev proxy must forward the browser's Host (localhost:5173) instead of
      // rewriting it to the target; otherwise every POST is rejected with
      // origin_mismatch.
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: false },
    },
  },
});
