// Transmit-from-Inara button lifetime — does it appear, and does it clear when it should?
//
//   npm i -D playwright && node tests/inara-transmit.test.mjs
//
// Serves the REAL colonization page over HTTP so the inline IIFE executes for real. Skips
// cleanly if playwright is absent.
//
// ⚠ WHY THIS SUITE EXISTS: the button's documented behaviour was wrong in three places at
// once. The title said "vanishes after two refreshes", the features page and the checklist
// both said it "times out on its own" — and the code had no timer at all, while ⟳ REFRESH
// (an in-place refetch, not a page load) never touched it. Three descriptions of a behaviour
// nobody had executed. So this file asserts the behaviour, and a negative control asserts the
// thing it must NOT do.
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.log('SKIP inara-transmit: playwright not installed (npm i -D playwright)'); process.exit(0); }
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
await new Promise(r => srv.listen(8098, '127.0.0.1', r));
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const R = []; const ok = (n, c, d = '') => R.push({ n, pass: !!c, d });

async function open_() {
  const ctx = await b.newContext();
  const pg = await ctx.newPage();
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1:8098/')) return route.continue();
    if (u.includes('whoami-cmdr')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, me: 'p@x.com', cmdr: 'BIGSKINNY', bound: true }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await pg.goto('http://127.0.0.1:8098/blades/colonization/index.html', { waitUntil: 'load' }).catch(() => {});
  return { ctx, pg };
}
const shown = pg => pg.evaluate(() => {
  const b = document.getElementById('inaraTxBtn');
  return !!b && b.style.display !== 'none';
});
// Arm the way a real click does — through the page's own capture listener, not by poking
// localStorage. Poking the key directly would test the storage format, not the wiring.
const armViaInaraClick = pg => pg.evaluate(() => {
  const a = document.createElement('a');
  a.href = 'https://inara.cz/elite/commodities/?test=1';
  // target=_blank matches the real markup — and without it a.click() navigates this page
  // away mid-test, which is how the first run of this suite died.
  a.target = '_blank'; a.rel = 'noopener';
  a.textContent = '↗ Inara';
  document.body.appendChild(a);
  a.click();
  return localStorage.getItem('ob_inaraTx');
});

// ── 1. it arms on an Inara click ─────────────────────────────────────────────
{
  const { ctx, pg } = await open_();
  const key = await armViaInaraClick(pg);
  ok('clicking an Inara link arms the button', (await shown(pg)) && key === '2', 'key=' + key);
  await ctx.close();
}

// ── 2. ⟳ REFRESH clears it — the whole point of this change ──────────────────
{
  const { ctx, pg } = await open_();
  await armViaInaraClick(pg);
  const before = await shown(pg);
  // Synthesise the refresh button if the manifest never rendered (no live project data in
  // this harness). The listener is delegated on document by ID, so a stand-in with the same
  // id exercises exactly the same path a rendered one would.
  await pg.evaluate(() => {
    if (!document.getElementById('refreshBtn')) {
      const btn = document.createElement('button');
      btn.id = 'refreshBtn'; btn.className = 'refresh-btn'; btn.textContent = '⟳ REFRESH';
      document.body.appendChild(btn);
    }
    document.getElementById('refreshBtn').click();
  });
  const after = await shown(pg);
  const key = await pg.evaluate(() => localStorage.getItem('ob_inaraTx'));
  ok('⟳ REFRESH clears the button', before && !after && key === null, `before=${before} after=${after} key=${key}`);
  await ctx.close();
}

// ── 3. NEGATIVE CONTROL — the SORT button must NOT clear it ──────────────────
// #msortBtn carries the same .refresh-btn CLASS. Matching on class instead of id would kill
// the button on a harmless re-sort, and nobody would connect the two.
{
  const { ctx, pg } = await open_();
  await armViaInaraClick(pg);
  await pg.evaluate(() => {
    const btn = document.createElement('button');
    btn.id = 'msortBtn'; btn.className = 'refresh-btn'; btn.textContent = '↕ SORT: NEED';
    document.body.appendChild(btn);
    btn.click();
  });
  ok('CONTROL the SORT button (same .refresh-btn class) does NOT clear it', await shown(pg));
  await ctx.close();
}

// ── 4. NEGATIVE CONTROL — an ordinary click elsewhere must not clear it ──────
{
  const { ctx, pg } = await open_();
  await armViaInaraClick(pg);
  await pg.evaluate(() => { document.body.click(); });
  ok('CONTROL a click on the page body does NOT clear it', await shown(pg));
  await ctx.close();
}

// ── 5. the page-load counter still governs, and it is LOADS not seconds ──────
{
  const { ctx, pg } = await open_();
  await armViaInaraClick(pg);
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await pg.reload({ waitUntil: 'load' }).catch(() => {});
    seen.push(await shown(pg));
  }
  ok('survives two page loads, gone on the third', seen[0] && seen[1] && !seen[2], JSON.stringify(seen));
  await ctx.close();
}

// ── 6. NEGATIVE CONTROL — no SHORT timer ─────────────────────────────────────
// ⚠ Scoped honestly: sitting idle for 3s proves there is no timer on that scale, which is
// what the removed "times out on its own if unused" copy implied to a reader. It does NOT
// prove the absence of, say, a 30-minute one — asserting that would need a fake clock, and a
// test that claims more than it checked is exactly what this suite exists to stop.
{
  const { ctx, pg } = await open_();
  await armViaInaraClick(pg);
  await pg.evaluate(() => new Promise(r => setTimeout(r, 3000)));
  ok('CONTROL no short timer: still present after 3s idle', await shown(pg));
  await ctx.close();
}

await b.close(); srv.close();
const fails = R.filter(r => !r.pass);
for (const r of R) console.log((r.pass ? '  ok   ' : '  FAIL ') + r.n + (r.pass || !r.d ? '' : '   [' + r.d + ']'));
console.log(`\n${R.length - fails.length}/${R.length} passed`);
process.exit(fails.length ? 1 : 0);
