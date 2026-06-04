import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
    base: "/c-visualizer/",
    plugins: [react()],
    optimizeDeps: {
        exclude: ["web-tree-sitter"],
    },
});
