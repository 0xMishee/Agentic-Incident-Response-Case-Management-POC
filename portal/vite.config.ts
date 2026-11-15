import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The portal talks to the case server through this proxy, so there is no CORS or URL to configure.
// Point IR_SERVER at another server if yours does not run on the default port.
const target = process.env.IR_SERVER ?? "http://127.0.0.1:7400";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target, changeOrigin: true } },
  },
});
