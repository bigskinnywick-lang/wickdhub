// Shared browser resolution for the Playwright suites.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// All five browser suites used to open with:
//
//   try { ({ chromium } = await import('playwright')); }
//   catch { console.log('SKIP …: playwright not installed'); process.exit(0); }
//   const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/…' });
//
// Two separate defects in three lines:
//
//  1. ★★ THE PATH WAS A GUESS THAT STOPPED BEING TRUE. package.json pins playwright
//     1.47, which ships **chromium-1134**. `chromium-1194` belongs to a different
//     release, so the path resolved to nothing on any machine that installed from
//     package.json. The launch then failed with a raw stack trace — or, on a machine
//     without the module at all, the catch above fired first and printed SKIP.
//
//  2. ★★ SKIP EXITED 0, SO A SUITE THAT RAN NOTHING LOOKED EXACTLY LIKE A SUITE THAT
//     PASSED. Roughly 52 assertions across five files reported as fine while executing
//     zero of them — including the suite covering the page whose Transmit button had
//     already been documented wrong in three places at once, which is the reason that
//     suite was written.
//
// This is the same shape as the heartbeat counter that reused the sweep's own filter,
// and the mutation harness that lied by dying: the check and the thing checked sharing
// a fault, so the check can only ever confirm it.
//
// ─── WHAT THIS DOES INSTEAD ──────────────────────────────────────────────────
//  · asks PLAYWRIGHT where its browser is — the library already knows, and it cannot
//    drift from the pinned version the way a literal path can
//  · `PW_CHROMIUM` overrides, for a system Chrome or an odd container layout
//  · tells the two failures apart: "the module is missing" and "the browser binary is
//    missing" need different fixes, and one message for both sent this to the wrong one
//  · `REQUIRE_BROWSER=1` turns a skip into exit 1, so a pipeline can demand these ran
//
// Usage:
//   import { launch } from './_browser.mjs';
//   const b = await launch('inara-transmit');
import fs from 'node:fs';

const HARD = process.env.REQUIRE_BROWSER === '1';

function bail(suite, reason, remedy) {
  const tag = HARD ? 'FAIL' : 'SKIP';
  console.log(`${tag} ${suite}: ${reason}`);
  console.log(`     fix: ${remedy}`);
  if (HARD) console.log('     (REQUIRE_BROWSER=1 — a suite that runs nothing is a failure here)');
  process.exit(HARD ? 1 : 0);
}

export async function launch(suite, opts = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    bail(suite, 'the playwright module is not installed',
      'npm i -D playwright && npx playwright install chromium');
  }

  // An explicit override wins, but it must exist — an override pointing at nothing is
  // how the old hardcoded path behaved, and that is the bug being fixed.
  const override = process.env.PW_CHROMIUM;
  if (override) {
    if (!fs.existsSync(override)) {
      bail(suite, `PW_CHROMIUM is set to ${override}, which does not exist`,
        'unset PW_CHROMIUM to use the browser playwright installed');
    }
    return chromium.launch({ executablePath: override, ...opts });
  }

  // Let playwright resolve its own install. This is the whole point: the answer comes
  // from the pinned version rather than from a string somebody typed once.
  let exe = '';
  try { exe = chromium.executablePath(); } catch { /* not downloaded */ }
  if (!exe || !fs.existsSync(exe)) {
    bail(suite, 'playwright is installed but its chromium is not downloaded',
      'npx playwright install chromium   (or set PW_CHROMIUM to a chrome binary)');
  }

  try {
    return await chromium.launch({ executablePath: exe, ...opts });
  } catch (e) {
    // Missing shared libraries land here, and the raw stack is unreadable. On a bare
    // Linux container the usual single culprit is libXdamage.so.1.
    bail(suite, `chromium failed to launch — ${String(e.message || e).split('\n')[0]}`,
      'npx playwright install-deps chromium  (no root? apt-get download libxdamage1, '
      + 'dpkg-deb -x it, and add its lib dir to LD_LIBRARY_PATH)');
  }
}
