import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  clearScreen: false,
  server: {
    strictPort: true,
    fs: { allow: [directory, path.resolve(directory, "../web/src")] },
  },
  build: {
    target: "es2021",
    sourcemap: false,
    minify: "esbuild",
  },
  test: {
    coverage: {
      provider: "v8",
      reportsDirectory: "../../coverage/javascript/desktop",
      reporter: ["text-summary", ["lcov", { projectRoot: "../.." }]],
      include: ["src/**/*.{js,jsx}"],
      exclude: ["src/**/*.test.*", "src/setupTests.js"],
      all: true,
    },
    environment: "jsdom",
    setupFiles: ["./src/setupTests.js"],
    restoreMocks: true,
  },
});
