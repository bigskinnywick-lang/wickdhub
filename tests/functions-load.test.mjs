// Does every Pages Function still parse, and do its imports resolve?
//
// Run: node tests/functions-load.test.mjs
//
// ─── WHY ─────────────────────────────────────────────────────────────────────
// On 2026-08-16 functions/_lib/ingest-auth.js became the FIRST cross-file import
// in functions/. Before that every Function was entirely self-contained, so a
// broken import was not a failure mode that existed here.
//
// It is now. If that import path is ever wrong, the failure is not subtle — every
// /ingest/* route 500s and the whole squadron's data flow stops. This test is the
// cheap way to find that out on a laptop instead of in production.
//
// Importing a module executes its top level, so this also catches a typo'd const
// or a bad regex — the things `node --check` on its own would miss.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FUNCTIONS = join(ROOT, "functions");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

// Every handler Pages will actually route, plus the shared lib they lean on.
const files = walk(FUNCTIONS).sort();
if (!files.length) { console.log("no function files found — wrong ROOT?"); process.exit(1); }

let pass = 0, fail = 0;
for (const f of files) {
  const rel = relative(ROOT, f);
  try {
    const m = await import(pathToFileURL(f).href);
    const handlers = Object.keys(m).filter((k) => k.startsWith("onRequest"));
    const isLib = rel.includes("/_");
    // A routed Function with no onRequest* export is dead weight — worth knowing.
    if (!isLib && !handlers.length) throw new Error("no onRequest* export — this route would 404");
    console.log(`  ok   ${rel}${handlers.length ? "  [" + handlers.join(", ") + "]" : "  (lib)"}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${rel}\n         ${e.message}`);
    fail++;
  }
}

console.log(`\n${pass} loaded, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
