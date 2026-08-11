// OB-1 panel (phase 2) — behavioural tests. Drives the real component in headless Chromium
// with a stubbed /blades/api/member, because the properties that matter here are runtime
// behaviour (does the inert control write? does a failed save revert?), not syntax.
//
//   npm i -D playwright && node tests/ob1-panel.test.mjs
//
// Skips cleanly (exit 0) if playwright isn't installed, so a fresh clone isn't blocked.
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.log('SKIP ob1-panel: playwright not installed (npm i -D playwright)'); process.exit(0); }
import http from 'node:http'; import fs from 'node:fs';
import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'ob1-'));
fs.mkdirSync(path.join(TMP, '_shell'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'docs/blades/_shell/ob1.js'), path.join(TMP, '_shell/ob1.js'));
fs.writeFileSync(path.join(TMP, 'host.html'), `<!doctype html><html><head><meta charset="utf-8"><style>:root{--muted:#888;--text:#eee;--accent:#f80;--accent-bright:#fb4;--accent-dim:#853;--line:#333;--bad:#f44;--warn:#fb0;--glow:#f80;--radius:3px;--font-head:sans-serif;--font-body:sans-serif}</style></head><body><div id="p"></div><script src="/_shell/ob1.js"></script><script>document.addEventListener("DOMContentLoaded",function(){OB1.mount(document.getElementById("p"),{mode:"settings"});});</script></body></html>`);
const srv=http.createServer((q,s)=>{const f=TMP+q.url.split('?')[0];
  if(fs.existsSync(f)&&fs.statSync(f).isFile()){s.writeHead(200,{'content-type':f.endsWith('.js')?'text/javascript':'text/html'});return s.end(fs.readFileSync(f));}s.writeHead(404);s.end();});
await new Promise(r=>srv.listen(8098,'127.0.0.1',r));
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const R=[];const ok=(n,c,d='')=>R.push({n,pass:!!c,d});

async function open(memberPayload, {patchStatus=200, patchBody=null, getStatus=200}={}) {
  const ctx=await b.newContext(); const pg=await ctx.newPage();
  const patches=[]; const errs=[];
  pg.on('pageerror',e=>errs.push(String(e).split('\n')[0]));
  await ctx.route('**/blades/api/member*', route=>{
    const rq=route.request();
    if(rq.method()==='PATCH'){ patches.push(JSON.parse(rq.postData()||'{}'));
      return route.fulfill({status:patchStatus,contentType:'application/json',
        body:JSON.stringify(patchBody|| {ok:true,member:{...memberPayload.member,prefs:{...memberPayload.member.prefs,...JSON.parse(rq.postData()||'{}').prefs}}})}); }
    return route.fulfill({status:getStatus,contentType:'application/json',body:JSON.stringify(memberPayload)});
  });
  await pg.goto('http://127.0.0.1:8098/host.html',{waitUntil:'load'});
  await pg.waitForTimeout(400);
  return {pg,ctx,patches,errs};
}
const base=(prefs)=>({ok:true,me:'p@x.com',cmdr:'TESTPILOT',provisioned:false,rigFeatureLive:false,
  member:{discord:'pilot#22',status:'ACTIVE',enlisted_at:1,last_seen_at:2,rev:1,prefs}});

// 1. strict rendering
{ const {pg,ctx,errs}=await open(base({show_on_roster:true,link_discord_public:false,show_activity:'true',credit_contributions:1}));
  const st=await pg.$$eval('.ob1-sw',els=>els.map(e=>[e.dataset.k,e.getAttribute('aria-checked'),e.getAttribute('aria-disabled')]));
  const m=Object.fromEntries(st.map(([k,c])=>[k,c]));
  ok('true renders on', m.show_on_roster==='true');
  ok('false renders off', m.link_discord_public==='false');
  ok('STRING "true" renders OFF (fail-closed)', m.show_activity==='false', JSON.stringify(m));
  ok('NUMBER 1 renders OFF (fail-closed)', m.credit_contributions==='false');
  ok('no pageerrors', errs.length===0, errs[0]||'');
  await ctx.close(); }
// 2. empty prefs => everything off
{ const {pg,ctx}=await open(base({}));
  const any=await pg.$$eval('.ob1-sw',els=>els.some(e=>e.getAttribute('aria-checked')==='true'));
  ok('EMPTY prefs => every switch off', any===false); await ctx.close(); }
// 3. inert rig control
{ const {pg,ctx,patches}=await open(base({show_on_roster:true}));
  const rig=await pg.$('.ob1-sw[data-k=list_rig]');
  ok('rig switch is aria-disabled', await rig.getAttribute('aria-disabled')==='true');
  await rig.click({force:true}); await pg.waitForTimeout(250);
  ok('clicking rig sends NO patch', patches.length===0, JSON.stringify(patches));
  ok('rig switch stays off', await rig.getAttribute('aria-checked')==='false');
  await ctx.close(); }
// 4. live toggle patches only that key
{ const {pg,ctx,patches}=await open(base({show_on_roster:true}));
  await pg.click('.ob1-sw[data-k=show_on_roster]'); await pg.waitForTimeout(300);
  ok('patch sent once', patches.length===1, JSON.stringify(patches));
  ok('patch carries ONLY that key', patches[0] && Object.keys(patches[0].prefs).length===1 && patches[0].prefs.show_on_roster===false);
  ok('patch never carries list_rig', !JSON.stringify(patches).includes('list_rig'));
  await ctx.close(); }
// 5. failed save reverts + surfaces
{ const {pg,ctx}=await open(base({show_on_roster:true}),{patchStatus:500});
  await pg.click('.ob1-sw[data-k=show_on_roster]'); await pg.waitForTimeout(400);
  ok('failed save REVERTS the switch', await pg.$eval('.ob1-sw[data-k=show_on_roster]',e=>e.getAttribute('aria-checked'))==='true');
  ok('failed save shows an error', await pg.$eval('#ob1Err',e=>!e.hidden));
  await ctx.close(); }
// 6. server's answer wins over optimistic UI
{ const {pg,ctx}=await open(base({show_on_roster:true}),{patchBody:{ok:true,member:{discord:'',status:'ACTIVE',prefs:{show_on_roster:true}}}});
  await pg.click('.ob1-sw[data-k=show_on_roster]'); await pg.waitForTimeout(400);
  ok('server value overrides optimistic flip', await pg.$eval('.ob1-sw[data-k=show_on_roster]',e=>e.getAttribute('aria-checked'))==='true');
  await ctx.close(); }
// 7. signed out => no member data
{ const {pg,ctx}=await open(base({show_on_roster:true}),{getStatus:403});
  const html=await pg.content();
  ok('signed out renders sign-in only', /Sign in to view/.test(html));
  const swCount=await pg.$$eval('.ob1-sw',e=>e.length);
  const bodyTxt=await pg.$eval('body',e=>e.innerText);
  ok('signed out renders ZERO switch elements', swCount===0, 'count='+swCount);
  ok('signed out leaks no cmdr/discord in DOM text', !bodyTxt.includes('TESTPILOT')&&!bodyTxt.includes('pilot#22'), bodyTxt.slice(0,80));
  ok('signed out: cmdr/discord absent from markup too', !(await pg.$eval('#p',e=>e.innerHTML)).match(/TESTPILOT|pilot#22/));
  await ctx.close(); }
// 8. preview copy present while rig feature dark
{ const {pg,ctx}=await open(base({}));
  const html=await pg.content();
  ok('Section III marked PREVIEW · NOT YET ACTIVE', /PREVIEW · NOT YET ACTIVE/.test(html));
  ok('"no real-world data" line shown while dark', /no real-world data about you at all/.test(html));
  await ctx.close(); }
// 9. that line must DISAPPEAR when the feature goes live
{ const p=base({}); p.rigFeatureLive=true; const {pg,ctx}=await open(p);
  ok('"no real-world data" line GONE when rig live', !/no real-world data about you at all/.test(await pg.content()));
  await ctx.close(); }
await b.close(); srv.close();
const f=R.filter(r=>!r.pass);
console.log(R.map(r=>(r.pass?'  ok  ':'  FAIL')+'  '+r.n+(r.d?'   '+r.d:'')).join('\n'));
console.log(`\n${R.length-f.length}/${R.length} passed`);
process.exit(f.length?1:0);
