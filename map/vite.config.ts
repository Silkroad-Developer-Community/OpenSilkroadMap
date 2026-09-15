import { defineConfig } from "vite";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

export default defineConfig({
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  server: {
    port: 3000,
    watch: {
      ignored: ["**/public/assets/**"],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
