import { defineConfig } from "tsup";

// Server build: bundle the native-http daemon entry into a single
// self-contained `dist/cli/server.mjs`, matching the pre-split production
// artifact.
// @iteam/shared is dependency-free so it is bundled in. The optional DB drivers
// stay external so users only pay for the backend they pick; the Lark SDK stays
// external because it is a large dep best resolved from node_modules at runtime.
export default defineConfig({
  entry: {
    server: "src/server.ts"
  },
  outDir: "dist/cli",
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  clean: ["dist/cli/**"],
  sourcemap: false,
  shims: false,
  // Inline the private @iteam/shared workspace package (tsup would otherwise
  // externalize it as a declared dependency) so the server bundle is
  // self-contained, matching the pre-split single-file artifact.
  noExternal: ["@iteam/shared"],
  external: ["better-sqlite3", "mysql2", "@larksuiteoapi/node-sdk"],
  outExtension: () => ({ js: ".mjs" })
});
