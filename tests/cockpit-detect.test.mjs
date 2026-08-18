// "Is this browser on the cockpit PC?" — the inference behind hiding ↵ GAME (b3.23).
//
//   npm i -D playwright && node tests/cockpit-detect.test.mjs
//
// Serves the REAL commander page with /blades/api/telemetry stubbed, so telemetry.js runs for
// real and we drive the inference with the same fields the plugin actually reports.
//
// ⚠ THE ASYMMETRY IS THE FEATURE, and most of this file exists to hold it in place:
//   • a blur is CONCLUSIVE (focus moved here → this is the cockpit) and sticks forever
//   • "remote" is a GUESS, so it takes two clean presses, and only ever from a refocus the
//     plugin says SUCCEEDED
//   • a FAILED refocus is discarded — it cannot distinguish "wrong machine" from "Windows
//     refused", and those want opposite responses
// Wrongly keeping a useless button costs pixels. Wrongly hiding a working one costs trust.
// The controls below are all of the second kind.
import { launch } from './_browser.mjs';
import http from 'node:http'; import fs from 'node:fs';
import path from 'node:path'; import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const srv = http.createServer((q, s) => {
  let f = ROOT + q.url.split('?')[0];
  if (f.endsWith('/')) f += 'index.html';
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    const ct = f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html';
    s.writeHead(200, { 'content-type': ct }); return s.end(fs.readFileSync(f));
  }
  s.writeHead(404); s.end('');
});
await new Promise(r => srv.listen(8099, '127.0.0.1', r));
const b = await launch('cockpit-detect');
const R = []; const ok = (n, c, d = '') => R.push({ n, pass: !!c, d });

// `rf` is mutable so a test can change what the plugin "reports" between polls, which is the
// only way to reproduce "the refocus completed" without a real rig.
async function open_({ query = '' } = {}) {
  const ctx = await b.newContext();
  const pg = await ctx.newPage();
  const state = { rf: { rfAt: 0, rfRung: '' } };
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.includes('/blades/api/telemetry')) {
      return route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({
          ok: true, cmdr: 'BIGSKINNY', ts: Date.now(), ageMs: 500, alerts: [],
          telemetry: Object.assign({ sys: 'Sol', ship: 'python', fuelPct: 80, cargo: 10, cargoCap: 256, status: 'Supercruise' }, state.rf)
        })
      });
    }
    if (u.includes('/blades/api/act')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, kind: 'button', ts: Date.now() }) });
    if (u.startsWith('http://127.0.0.1:8099/') && !u.includes('/blades/api/')) return route.continue();
    if (u.includes('whoami-cmdr')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, cmdr: 'BIGSKINNY', bound: true }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await pg.goto('http://127.0.0.1:8099/blades/commander/index.html' + query, { waitUntil: 'load' }).catch(() => {});
  await pg.waitForSelector('#obBackFix', { timeout: 8000 }).catch(() => {});
  return { ctx, pg, state };
}
const visible = pg => pg.evaluate(() => {
  const b = document.querySelector('#obBackFix');
  return !!b && b.style.display !== 'none';
});
const verdict = pg => pg.evaluate(() => [localStorage.getItem('ob_rf_dev'), localStorage.getItem('ob_rf_miss')]);
const press = pg => pg.evaluate(() => document.querySelector('#obBackFix').click());
// One press whose refocus the plugin reports as `rung`, with the browser NOT blurring.
// ⚠ POLL_MS is 5000. Never wait a fixed 2.6s for a poll-driven verdict — that is the
// fixed-sleep-in-a-polling-test trap tests/alert-lane.test.mjs already records, and it made
// the first run of this file report three false failures. Wait on the OBSERVABLE when a
// change is expected; wait a full poll cycle plus slack only when asserting nothing happened.
async function pressNoBlur(pg, state, rung, expectMiss) {
  const before = await pg.evaluate(() => localStorage.getItem('ob_rf_miss'));
  await press(pg);
  state.rf = { rfAt: (state.rf.rfAt || 1700000000000) + 5000, rfRung: rung };
  if (expectMiss != null) {
    await pg.waitForFunction(n => localStorage.getItem('ob_rf_miss') === String(n),
                             expectMiss, { timeout: 15000 }).catch(() => {});
  } else {
    await pg.waitForTimeout(7000);          // a full poll cycle + slack: "nothing happened"
  }
  return before;
}

// ── 1. it starts visible — no verdict yet means no hiding ────────────────────
{
  const { ctx, pg } = await open_();
  ok('button is visible before any evidence', await visible(pg));
  await ctx.close();
}

// ── 2. one clean miss is NOT enough to hide ──────────────────────────────────
{
  const { ctx, pg, state } = await open_();
  await pressNoBlur(pg, state, 'alt-tap', 1);
  const [v, m] = await verdict(pg);
  ok('CONTROL one successful-but-no-blur press does NOT hide it',
     (await visible(pg)) && v !== 'remote' && m === '1', `verdict=${v} misses=${m}`);
  await ctx.close();
}

// ── 3. two clean misses hide it ──────────────────────────────────────────────
{
  const { ctx, pg, state } = await open_();
  await pressNoBlur(pg, state, 'alt-tap', 1);
  await pressNoBlur(pg, state, 'direct', 2);
  const [v] = await verdict(pg);
  ok('two successful-but-no-blur presses hide it', !(await visible(pg)) && v === 'remote', `verdict=${v}`);
  await ctx.close();
}

// ── 4. NEGATIVE CONTROL — a FAILED refocus is not evidence ───────────────────
// This is the important one. On the rig the alarm path failed for weeks; if failures counted,
// the pilot's own machine would have hidden its own button.
{
  const { ctx, pg, state } = await open_();
  await pressNoBlur(pg, state, 'failed');
  await pressNoBlur(pg, state, 'failed');
  await pressNoBlur(pg, state, 'failed');
  const [v, m] = await verdict(pg);
  ok('CONTROL three FAILED refocuses never hide it',
     (await visible(pg)) && v !== 'remote' && (m === null || m === '0'), `verdict=${v} misses=${m}`);
  await ctx.close();
}

// ── 5. a blur is conclusive, and it sticks ───────────────────────────────────
{
  const { ctx, pg, state } = await open_();
  await press(pg);
  await pg.evaluate(() => window.dispatchEvent(new Event('blur')));
  state.rf = { rfAt: 1700000009000, rfRung: 'alt-tap' };   // a rung that ACTUALLY moved
  await pg.waitForFunction(() => localStorage.getItem('ob_rf_dev') === 'cockpit', null, { timeout: 15000 }).catch(() => {});
  const [v] = await verdict(pg);
  ok('a blur after the press records this device as the cockpit', v === 'cockpit', `verdict=${v}`);

  // …and having been judged the cockpit, later misses must not undo it.
  await pressNoBlur(pg, state, 'alt-tap');
  await pressNoBlur(pg, state, 'alt-tap');
  const [v2] = await verdict(pg);
  ok('CONTROL a cockpit verdict is not overturned by later misses',
     v2 === 'cockpit' && (await visible(pg)), `verdict=${v2}`);
  await ctx.close();
}

// ── 5b. THE MAC CASE — a blur with no movement is NOT the cockpit (2026-08-13) ──
// The bug this replaces: judgeDevice checked `blurred` first and called it conclusive. A Mac
// blurred for its own reasons inside the 12s window and marked itself the cockpit, stickily.
// The rung is the disambiguator — "already" means the plugin moved NOTHING, so a blur in that
// window cannot have been caused by it.
{
  const { ctx, pg, state } = await open_();
  await press(pg);
  await pg.evaluate(() => window.dispatchEvent(new Event('blur')));   // incidental app switch
  state.rf = { rfAt: 1700000777000, rfRung: 'already' };              // Elite was already there
  await pg.waitForFunction(() => localStorage.getItem('ob_rf_miss') === '1', null, { timeout: 15000 }).catch(() => {});
  const [v, m] = await verdict(pg);
  ok('CONTROL blur + rung "already" does NOT claim cockpit — it counts as remote',
     v !== 'cockpit' && m === '1', `verdict=${v} misses=${m}`);
  await ctx.close();
}

// …and "already" twice, blur or not, hides it. This is the real remote-device path now.
{
  const { ctx, pg, state } = await open_();
  for (const t of [1, 2]) {
    await press(pg);
    state.rf = { rfAt: 1700000800000 + t * 5000, rfRung: 'already' };
    await pg.waitForFunction(n => localStorage.getItem('ob_rf_miss') === String(n), t, { timeout: 15000 }).catch(() => {});
  }
  const [v] = await verdict(pg);
  ok('two "already" presses hide it (the tablet/Mac path)', v === 'remote' && !(await visible(pg)), `verdict=${v}`);
  await ctx.close();
}

// The rig still works: a rung that REALLY moved, plus a blur, is the cockpit.
{
  const { ctx, pg, state } = await open_();
  await press(pg);
  await pg.evaluate(() => window.dispatchEvent(new Event('blur')));
  state.rf = { rfAt: 1700000999000, rfRung: 'alt-tap' };
  await pg.waitForFunction(() => localStorage.getItem('ob_rf_dev') === 'cockpit', null, { timeout: 15000 }).catch(() => {});
  const [v] = await verdict(pg);
  ok('a REAL move + blur still marks the rig as cockpit', v === 'cockpit', `verdict=${v}`);
  await ctx.close();
}

// A real move with NO blur means it moved somewhere else — remote evidence.
{
  const { ctx, pg, state } = await open_();
  await pressNoBlur(pg, state, 'alt-tap', 1);
  const [, m] = await verdict(pg);
  ok('CONTROL real move without a blur still counts as remote', m === '1', `misses=${m}`);
  await ctx.close();
}

// ── 6. hiding is recoverable ─────────────────────────────────────────────────
{
  const { ctx, pg, state } = await open_();
  await pressNoBlur(pg, state, 'alt-tap', 1);
  await pressNoBlur(pg, state, 'direct', 2);
  ok('precondition: hidden', !(await visible(pg)));
  await pg.goto('http://127.0.0.1:8099/blades/commander/index.html?rfbutton=1', { waitUntil: 'load' }).catch(() => {});
  await pg.waitForSelector('#obBackFix', { timeout: 8000 }).catch(() => {});
  ok('?rfbutton=1 brings it back', await visible(pg));
  await ctx.close();
}

// ── 6b. the reset must fire ONCE, not on every poll (2026-08-13) ──────────────
// showBackBtn() -> forceShow() runs from paintBack(), i.e. every poll and every second from
// the age timer. An un-memoised reset wipes the miss counter continuously, so the device it
// is meant to rescue can never re-learn. This asserts misses ACCUMULATE with the flag present.
{
  const { ctx, pg, state } = await open_({ query: '?rfbutton=1' });
  await pressNoBlur(pg, state, 'already', 1);
  const [, m1] = await verdict(pg);
  await pg.waitForTimeout(3000);                       // several polls with the flag still set
  const [, m1b] = await verdict(pg);
  ok('CONTROL ?rfbutton=1 does not re-clear on every poll', m1 === '1' && m1b === '1', `${m1} -> ${m1b}`);
  await pressNoBlur(pg, state, 'already', 2);
  const [v] = await verdict(pg);
  ok('a reset device can still re-learn to "remote"', v === 'remote', `verdict=${v}`);
  await ctx.close();
}

// ── 7. NEGATIVE CONTROL — no press, no judgement ─────────────────────────────
// Polls arrive every few seconds forever. If rfAt changing were enough on its own, an alarm
// refocus on the rig would silently hide the button on a browser nobody had touched.
{
  const { ctx, pg, state } = await open_();
  state.rf = { rfAt: 1700000123000, rfRung: 'alt-tap' };
  await pg.waitForTimeout(3000);
  state.rf = { rfAt: 1700000456000, rfRung: 'alt-tap' };
  await pg.waitForTimeout(3000);
  const [v, m] = await verdict(pg);
  ok('CONTROL refocuses the pilot did NOT trigger from here are ignored',
     (await visible(pg)) && v !== 'remote' && (m === null || m === '0'), `verdict=${v} misses=${m}`);
  await ctx.close();
}

await b.close(); srv.close();
const fails = R.filter(r => !r.pass);
for (const r of R) console.log((r.pass ? '  ok   ' : '  FAIL ') + r.n + (r.pass || !r.d ? '' : '   [' + r.d + ']'));
console.log(`\n${R.length - fails.length}/${R.length} passed`);
process.exit(fails.length ? 1 : 0);
