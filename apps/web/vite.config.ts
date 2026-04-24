import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Load repo-root .env so WEB_PORT / API_PORT flow through when starting via npm run dev.
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../.env"), quiet: true });

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: Number(process.env["WEB_PORT"] ?? 3000),
    strictPort: true,
  },
});
