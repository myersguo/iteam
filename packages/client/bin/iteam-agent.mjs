#!/usr/bin/env node
// Thin shim: re-export the pre-bundled iteam-agent CLI. Compiled via tsup before publish.
import "../dist/cli/iteam-agent.mjs";
