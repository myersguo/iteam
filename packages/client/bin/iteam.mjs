#!/usr/bin/env node
// Thin shim: re-export the pre-bundled CLI entry. Compiled via tsup before publish.
import "../dist/cli/iteam.mjs";
