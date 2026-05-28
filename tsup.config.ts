import { defineConfig } from "tsup";

// Bundle every CLI / runtime entry into a single `.mjs` per entry. Heavy
// optional deps (better-sqlite3, mysql2) stay external so users only pay for
// the backend they pick. React/UI deps are excluded too — those go through
// vite into dist/assets/ for the browser, never into the Node CLI.
export default defineConfig({
  entry: {
    iteam: "bin/iteam.ts",
    "iteam-agent": "bin/iteam-agent.ts",
    server: "src/server.ts",
    "agent-daemon": "src/agent-daemon.ts",
    "chat-bridge": "src/chat-bridge.ts"
  },
  outDir: "dist/cli",
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  // Only clean our own outDir; don't wipe dist/assets/ produced by vite build.
  clean: ["dist/cli/**"],
  sourcemap: false,
  shims: false,
  external: [
    "better-sqlite3",
    "mysql2",
    "react",
    "react-dom",
    "lucide-react",
    "react-markdown",
    "remark-gfm",
    "vite",
    "@vitejs/plugin-react"
  ],
  // No `banner` shebang here — the bundled `.mjs` files are imported by the
  // thin shims in `bin/*.mjs` (which carry the shebang). Injecting `#!/usr/bin/env node`
  // into the bundle breaks `import` parsing in Node.
  outExtension: () => ({ js: ".mjs" })
});
