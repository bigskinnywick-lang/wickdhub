// Alert lane page-mounting tests — does the klaxon/flash reach the page you actually fly with?
//
//   npm i -D playwright && node tests/alert-lane.test.mjs
//
// Serves the REAL page files over HTTP with /blades/api/telemetry stubbed, so relative
// fetches resolve and telemetry.js executes for real. Skips cleanly if playwright is absent.
//
// ⚠ TWO TRAPS, both of which made this suite lie before they were fixed:
//   1. telemetry.js marks the backlog present at PAGE LOAD as seen, SILENTLY — by design, so
//      a re-poll never re-sounds. An alert delivered on the FIRST poll can therefore never
//      flash. Deliver it on a LATER poll, the way a real scan arrives. (Getting this wrong
//      made commander — which was not being changed — fail too, and that is what gave the
//      harness away rather than the code.)
//   2. Stub an un-authed pilot as a real 403, not as a happy payload with bound:false.
//      A cheerful stub mounted the strip and hid the fact that nothing gates it.
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
await new Promise(r=>srv.listen(8097,'127.0.0.1',r));
const b=await launch('alert-lane', { args: ['--autoplay-policy=no-user-gesture-required'] });
const R=[];const ok=(n,c,d='')=>R.push({n,pass:!!c,d});

// ⚠ telemetry.js deliberately marks the backlog present at PAGE LOAD as seen, silently —
// a re-poll of the same log must never re-sound. So an alert delivered on the FIRST poll
// can never flash. To test the alarm you must deliver it on a LATER poll, exactly as a real
// scan arrives. Getting this wrong made commander (unchanged) fail too, which is what gave
// the harness away.
async function run(page, {alerts=[], bound=true, deliverAfterMs=0, unauth=false}={}) {
  const ctx=await b.newContext(); const pg=await ctx.newPage();
  const errs=[]; pg.on('pageerror',e=>errs.push(String(e).split('\n')[0]));
  let telHits=0; const t0=Date.now();
  await ctx.route('**/*',route=>{
    const u=route.request().url();
    if(u.includes('/blades/api/telemetry')){ telHits++;
      if(unauth) return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({ok:false,error:'forbidden'})});
      const live = (Date.now()-t0) >= deliverAfterMs ? alerts : [];
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
        ok:true, ts:Date.now(),
        telemetry: bound?{system:'Sol',ship:'python',fuelPct:42,cargo:64,cargoCap:256,state:'Supercruise',ts:Date.now()}:null,
        alerts: live })}); }
    if(u.includes('whoami-cmdr')) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,me:'p@x.com',cmdr:bound?'BIGSKINNY':'',bound})});
    if(u.includes('get-identity')) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({email:'p@x.com',name:'Pilot'})});
    if(u.startsWith('http://127.0.0.1:8097/')) return route.continue();
    return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
  });
  await pg.goto('http://127.0.0.1:8097/blades/'+page+'/index.html',{waitUntil:'load'}).catch(()=>{});
  await pg.waitForTimeout(deliverAfterMs ? deliverAfterMs+9000 : 2500);
  const st=await pg.evaluate(()=>({
    alertStrip: !!document.getElementById('obAlertStrip'),
    telStrip:   !!document.getElementById('obTelStrip'),
    pageFlash:  !!document.getElementById('obPageFlash'),
    flashOn:    !!(document.getElementById('obPageFlash')||{}).className?.includes('on'),
    stripFlash: (document.getElementById('obAlertStrip')||{}).className||'',
    alertText:  (document.getElementById('obAlertStrip')||{}).innerText||''
  }));
  await ctx.close();
  return {st,errs,telHits};
}
const CRIT=[{level:'critical',msg:'PIRATE INBOUND - hostile hail',ts:Date.now(),id:'a1'}];

// 1. colonization — the change under test
{ const {st,errs,telHits}=await run('colonization',{alerts:CRIT,deliverAfterMs:6000});
  ok('colonization polls the telemetry lane', telHits>0, 'hits='+telHits);
  ok('colonization mounts the ALERT strip', st.alertStrip);
  ok('colonization mounts the page-flash layer', st.pageFlash);
  ok('colonization mounts the tile row', st.telStrip);
  ok('a critical alert FLASHES the strip', /flash-critical/.test(st.stripFlash), st.stripFlash);
  ok('the alert text is rendered', /PIRATE INBOUND/.test(st.alertText), st.alertText.slice(0,60));
  ok('no pageerrors on colonization', errs.length===0, errs[0]||''); }
// 2. commander — regression
{ const {st,errs}=await run('commander',{alerts:CRIT,deliverAfterMs:6000});
  ok('commander still mounts alerts', st.alertStrip);
  ok('commander still flashes', /flash-critical/.test(st.stripFlash));
  ok('no pageerrors on commander', errs.length===0, errs[0]||''); }
// 3. quiet lane must NOT flash
{ const {st}=await run('colonization',{alerts:[]});
  ok('no alerts => no flash', !/flash-critical|flash-warn/.test(st.stripFlash), st.stripFlash); }
// 4. unbound pilot must not mount
{ const {st}=await run('colonization',{alerts:CRIT,unauth:true});
  ok('un-authed pilot (403): nothing mounts', !st.alertStrip && !st.telStrip, JSON.stringify(st)); }
await b.close(); srv.close();
const f=R.filter(r=>!r.pass);
console.log(R.map(r=>(r.pass?'  ok  ':'  FAIL')+'  '+r.n+(r.d?'   '+r.d:'')).join('\n'));
console.log(`\n${R.length-f.length}/${R.length} passed`);
process.exit(f.length?1:0);
