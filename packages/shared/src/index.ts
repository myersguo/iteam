// Barrel for @iteam/shared - the code reused by the server, client daemon/CLI,
// and web app. Kept dependency-free (Node builtins only) so it can be consumed
// by tsup, tsc, and Vite without extra wiring.
export * from "./types.js";
export * from "./lib.js";
export * from "./http-client.js";
