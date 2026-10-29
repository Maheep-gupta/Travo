import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Loopback only: this dev server must not be reachable from the network.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
