// Telemetry tile display — LIVE vs STALE vs NEVER-REPORTED.
//
//   npm i -D playwright && node tests/telemetry-display.test.mjs
//
// Serves the REAL page files over HTTP with /blades/api/telemetry stubbed, so telemetry.js
// executes for real. Skips cleanly if playwright is absent.
//
// The rule under test (Adam, 2026-08-12): a quiet feed must FAIL TO GREY, NOT TO BLANK.
// Jumps and loading screens routinely pause the heartbeat past STALE_MS, and wiping every
// tile to "—" threw away readings that were good moments earlier. Honesty is preserved by
// the grey + the "stale · last seen Nm ago" header, not by destroying the data.
//
// Three states, all asserted, because they are easy to conflate:
//   live            -> values, no grey, fuel threshold glow ACTIVE
//   stale           -> values KEPT, greyed, fuel keeps its NUMBER but DROPS the alarm class
//                      (a red "critical fuel" tile on a dead feed is a claim about NOW)
//   never reported  -> dashes, because there is genuinely nothing to show
import { launch } from './_browser.mjs';
import http from 'node:http'; import fs from 'node:fs';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const srv=http.createServer((q,s)=>{let f=ROOT+q.url.split('?')[0];
  if(f.endsWith('/'))f+='index.html';
  if(fs.existsSync(f)&&fs.statSync(f).isFile()){
    const ct=f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html';
    s.writeHead(200,{'content-type':ct});return s.end(fs.readFileSync(f));}
  s.writeHead(404);s.end('');});
await new Promise(r=>srv.listen(8096,'127.0.0.1',r));
const b=await launch('telemetry-display');
const R=[];const ok=(n,c,d='')=>R.push({n,pass:!!c,d});
const TEL={system:'Sol',ship:'panthermkii',shipName:'Kudzu',fuelPct:8,cargo:64,cargoCap:1104,status:'Supercruise'};

// ageMode: 'live' | 'stale' | 'none'  (none = plugin never reported)
async function look(page, ageMode) {
  const ctx=await b.newContext(); const pg=await ctx.newPage();
  const errs=[]; pg.on('pageerror',e=>errs.push(String(e).split('\n')[0]));
  await ctx.route('**/*',route=>{
    const u=route.request().url();
    if(u.includes('/blades/api/telemetry')){
      const body = ageMode==='none'
        ? {ok:true, ts:Date.now(), telemetry:null, alerts:[]}
        : {ok:true, ts:Date.now(), ageMs: ageMode==='stale' ? 180000 : 1200,
           telemetry:{sys:TEL.system,ship:TEL.ship,shipName:TEL.shipName,fuelPct:TEL.fuelPct,
                      cargo:TEL.cargo,cargoCap:TEL.cargoCap,status:TEL.status}, alerts:[]};
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    }
    if(u.includes('whoami-cmdr')) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,cmdr:'BIGSKINNY',bound:true})});
    if(u.startsWith('http://127.0.0.1:8096/')) return route.continue();
    return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
  });
  await pg.goto('http://127.0.0.1:8096/blades/'+page+'/index.html',{waitUntil:'load'}).catch(()=>{});
  await pg.waitForTimeout(2200);
  const st=await pg.evaluate(()=>{
    const s=document.getElementById('obTelStrip'); if(!s) return {mounted:false};
    const tiles={}; s.querySelectorAll('.ot-tile').forEach(e=>{
      tiles[e.dataset.t]={val:e.querySelector('.ot-val').textContent.trim(), cls:e.className};});
    return {mounted:true, stale:s.classList.contains('stale'),
            ago:(s.querySelector('.ot-ago')||{}).textContent||'', tiles};
  });
  await ctx.close(); return {st,errs};
}
{ const {st,errs}=await look('commander','live');
  ok('LIVE: values shown', st.tiles.sys.val==='Sol' && st.tiles.cargo.val.startsWith('64'), JSON.stringify(st.tiles.sys));
  ok('LIVE: not marked stale', st.stale===false);
  ok('LIVE: low fuel keeps its warning class', /crit|warn/.test(st.tiles.fuel.cls), st.tiles.fuel.cls);
  ok('LIVE: header says LIVE', /LIVE/.test(st.ago), st.ago);
  ok('no pageerrors', errs.length===0, errs[0]||''); }
{ const {st}=await look('commander','stale');
  ok('★ STALE: values are KEPT, not dashed', st.tiles.sys.val==='Sol' && st.tiles.ship.val!=='—' && st.tiles.cargo.val.startsWith('64'), JSON.stringify(st.tiles));
  ok('STALE: strip greyed', st.stale===true);
  ok('STALE: header says last seen', /stale · last seen/.test(st.ago), st.ago);
  ok('★ STALE: fuel keeps the NUMBER', /8/.test(st.tiles.fuel.val), st.tiles.fuel.val);
  ok('★ STALE: fuel drops the alarm class', !/crit|warn/.test(st.tiles.fuel.cls), st.tiles.fuel.cls); }
{ const {st}=await look('commander','none');
  ok('NEVER REPORTED: still dashes', st.tiles.sys.val==='—' && st.tiles.cargo.val==='—', JSON.stringify(st.tiles.sys)); }
{ const {st}=await look('colonization','stale');
  ok('colonization behaves the same', st.tiles.sys.val==='Sol' && st.stale===true); }
await b.close(); srv.close();
const f=R.filter(r=>!r.pass);
console.log(R.map(r=>(r.pass?'  ok  ':'  FAIL')+'  '+r.n+(r.d?'   '+r.d:'')).join('\n'));
console.log(`\n${R.length-f.length}/${R.length} passed`);
process.exit(f.length?1:0);
