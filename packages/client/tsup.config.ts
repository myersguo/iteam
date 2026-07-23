import { defineConfig } from "tsup";

// Bundle every client CLI / runtime entry into a single `.mjs` per entry.
// @iteam/shared is dependency-free (Node builtins only) so it is bundled in,
// keeping the published package self-contained. The heavy DB drivers and all
// React/UI deps now live in the server/web packages, so this package no longer
// needs to externalize them.
export default defineConfig({
  entry: {
    iteam: "bin/iteam.ts",
    "iteam-agent": "bin/iteam-agent.ts",
    "agent-daemon": "src/agent-daemon.ts",
    "chat-bridge": "src/chat-bridge.ts"
  },
  outDir: "dist/cli",
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  clean: true,
  sourcemap: false,
  shims: false,
  // tsup auto-externalizes `dependencies`, but @iteam/shared is a private
  // workspace package that is never published to npm — it MUST be inlined so
  // the published @myersguo/iteam is self-contained.
  noExternal: ["@iteam/shared"],
  // No `banner` shebang — the bundled `.mjs` files are imported by the thin
  // shims in `bin/*.mjs` (which carry the shebang). Injecting a shebang into
  // the bundle breaks `import` parsing in Node.
  outExtension: () => ({ js: ".mjs" })
});
