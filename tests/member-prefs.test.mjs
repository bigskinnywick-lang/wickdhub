import * as M from '../functions/blades/api/member.js';
import * as X from '../functions/blades/api/export.js';
const ME='pilot@example.com';
function kv(seed={}){ const s=new Map(Object.entries(seed)); return {
  _s:s, async get(k){ return s.has(k)? s.get(k): null; }, async put(k,v){ s.set(k,String(v)); },
  async delete(k){ s.delete(k); },
  async list({cursor}={}){ return { keys:[...s.keys()].map(name=>({name})), list_complete:true, cursor:null }; } }; }
function req(url='https://w/blades/api/member',{method='GET',body,email=ME}={}) {
  const h={'Cf-Access-Authenticated-User-Email':email};
  return new Request(url,{method,headers:h,...(body?{body:JSON.stringify(body)}:{})});
}
const R=[]; const ok=(n,c,d='')=>R.push({test:n,pass:!!c,detail:d});

// ---- pure fail-closed logic ----
ok('visible: absent pref => false', M.visible({}, 'show_on_roster')===false);
ok('visible: string "true" => false', M.visible({show_on_roster:'true'},'show_on_roster')===false);
ok('visible: 1 => false', M.visible({show_on_roster:1},'show_on_roster')===false);
ok('visible: true => true', M.visible({show_on_roster:true},'show_on_roster')===true);
ok('visible: null prefs => false', M.visible(null,'show_on_roster')===false);
const bare=M.publicView({prefs:{},discord:'secret#1',status:'ACTIVE'},'BIGSKINNY');
ok('EMPTY PREFS => nothing but a number', bare.cmdr===''&&bare.discord===''&&bare.named===false&&bare.activity===false&&bare.credited===false, JSON.stringify(bare));
const roster=M.publicView({prefs:{show_on_roster:true},discord:'secret#1'},'BIGSKINNY');
ok('on roster but discord OFF => handle withheld', roster.cmdr==='BIGSKINNY'&&roster.discord==='');
const both=M.publicView({prefs:{show_on_roster:true,link_discord_public:true},discord:'h#1'},'BIG');
ok('both ON => handle shown', both.discord==='h#1');
const hidden=M.publicView({prefs:{show_on_roster:false,link_discord_public:true},discord:'h#1'},'BIG');
ok('unnamed member never leaks handle even if link pref ON', hidden.cmdr===''&&hidden.discord==='');

// ---- sanitize ----
ok('rejects list_rig while feature dark', M.sanitizePrefs({list_rig:true}).rejected.includes('list_rig'));
ok('list_rig absent from accepted prefs', !('list_rig' in M.sanitizePrefs({list_rig:true}).prefs));
ok('rejects unknown key', M.sanitizePrefs({is_admin:true}).rejected.includes('is_admin'));
ok('rejects non-boolean', M.sanitizePrefs({show_activity:'yes'}).rejected.includes('show_activity'));
ok('accepts real boolean', M.sanitizePrefs({show_activity:false}).prefs.show_activity===false);
ok('cleanDiscord invalid => null', M.cleanDiscord('a b!!<script>')===null);
ok('cleanDiscord empty => ""', M.cleanDiscord('')==='');

// ---- GET provisioning ----
{ const env={BUILDS:kv({['cmdrlink:'+ME]:JSON.stringify({cmdr:'TESTPILOT'})})};
  const r1=await M.onRequestGet({request:req(),env}); const j1=await r1.json();
  ok('first GET provisions', j1.provisioned===true, JSON.stringify(j1.member.prefs));
  const stored=JSON.parse(await env.BUILDS.get('member:'+ME));
  ok('defaults WRITTEN explicitly to KV', stored.prefs.show_on_roster===true&&stored.prefs.link_discord_public===false&&stored.prefs.show_activity===true&&stored.prefs.credit_contributions===true);
  ok('list_rig NOT written while dark', !('list_rig' in stored.prefs));
  ok('cmdr joined from cmdrlink (not copied)', j1.cmdr==='TESTPILOT');
  const r2=await M.onRequestGet({request:req(),env}); const j2=await r2.json();
  ok('second GET does not re-provision', j2.provisioned===false);
}
// ---- PATCH ----
{ const env={BUILDS:kv()};
  await M.onRequestGet({request:req(),env});
  const rp=await M.onRequestPatch({request:req('https://w/blades/api/member',{method:'PATCH',body:{prefs:{show_on_roster:false,list_rig:true,evil:true},discord:'pilot#22'}}),env});
  const jp=await rp.json();
  ok('PATCH applies allowed pref', jp.member.prefs.show_on_roster===false);
  ok('PATCH stores discord', jp.member.discord==='pilot#22');
  ok('PATCH rejects list_rig + unknown', jp.rejected.includes('list_rig')&&jp.rejected.includes('evil'));
  ok('PATCH never stores list_rig', !('list_rig' in jp.member.prefs));
  const bad=await M.onRequestPatch({request:req('https://w/blades/api/member',{method:'PATCH',body:{discord:'no spaces<>'}}),env});
  ok('PATCH rejects bad discord with 400', bad.status===400);
}
// ---- identity isolation ----
{ const env={BUILDS:kv()};
  await M.onRequestGet({request:req('https://w/blades/api/member',{email:'a@x.com'}),env});
  await M.onRequestGet({request:req('https://w/blades/api/member',{email:'b@x.com'}),env});
  ok('records are per-email', env.BUILDS._s.has('member:a@x.com')&&env.BUILDS._s.has('member:b@x.com'));
  const noid=await M.onRequestGet({request:new Request('https://w/blades/api/member'),env});
  ok('no identity => 403', noid.status===403);
}
// ---- export redaction ----
{ const seed={'member:p@x.com':JSON.stringify({discord:'h#1'}),'rig:p@x.com':JSON.stringify({stick:'VPC'}),
   'cmdrlink:p@x.com':JSON.stringify({cmdr:'P'}),'admin:emails':JSON.stringify(['bigskinnywick@gmail.com']),
   'home:wisdom':JSON.stringify({t:'hi'})};
  const env={BUILDS:kv(seed)};
  const r=await X.onRequestGet({request:req('https://w/blades/api/export',{email:'bigskinnywick@gmail.com'}),env});
  const j=await r.json(); const blob=JSON.stringify(j);
  ok('DEFAULT export omits member/rig/cmdrlink', !blob.includes('h#1')&&!blob.includes('VPC')&&!/"cmdr":"P"/.test(blob), blob.slice(0,0));
  ok('default export still counts them', j.redacted.counts['member:']===1&&j.redacted.counts['rig:']===1&&j.redacted.counts['cmdrlink:']===1);
  ok('default export keeps non-personal data', blob.includes('home:wisdom'));
  ok('blob self-describes mode', j.redacted.personalIncluded===false);
  const r2=await X.onRequestGet({request:req('https://w/blades/api/export?include=personal',{email:'bigskinnywick@gmail.com'}),env});
  const j2=await r2.json(); const blob2=JSON.stringify(j2);
  ok('?include=personal DOES include them', blob2.includes('h#1')&&blob2.includes('VPC'));
  ok('full export flags itself DO NOT COMMIT', /DO NOT COMMIT/.test(j2.redacted.mode));
  const nonAdmin=await X.onRequestGet({request:req('https://w/blades/api/export',{email:'rando@x.com'}),env});
  ok('export forbidden to non-admin', nonAdmin.status===403);
}
const fail=R.filter(r=>!r.pass);
console.log(R.map(r=>(r.pass?'  ok  ':'  FAIL')+'  '+r.test+(r.detail?'   '+r.detail:'')).join('\n'));
console.log(`\n${R.length-fail.length}/${R.length} passed`);
process.exit(fail.length?1:0);
