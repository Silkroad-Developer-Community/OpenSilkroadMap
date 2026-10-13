import { defineConfig } from "vite";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

export default defineConfig({
  base: Deno.env.get("PAGES_BASE_PATH") ?? "/",
  publicDir: Deno.env.get("PAGES_PUBLIC_DIR") ?? "public",
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  server: {
    port: 3000,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
