import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {collectionReadiness,publishData,DATA_FILES,PUBLISH_FILES} from '../scripts/feed-operations.mjs';

import {OIL_SOURCES,validateOil} from '../src/oil-data.js';
import {COMMODITY_CONTRACTS} from '../src/commodity-positioning.js';
import {FEED_SCHEMA,FEED_INTERVAL,ECB_FEED_SOURCE} from '../src/feed-contract.js';
import {referenceSeries,frameFromSeries,FORMULA_VERSION} from '../src/reference-math.js';
import {POSITIONING_SCHEMA} from '../src/positioning.js';

// Fixed synthetic data keeps publication tests independent of source outages.
const collected_at='2026-10-14T07:49:30.319Z',now=Date.parse(collected_at),DAY=86400000;
const fixture=()=>{
 const inputs=Object.fromEntries(Object.entries({EURUSD:1.1,GBPUSD:1.3,USDJPY:150}).map(([pair,rate])=>[pair,Array.from({length:81},(_,i)=>[new Date(Date.parse('2026-10-13')-(80-i)*DAY).toISOString().slice(0,10),rate])]));
 const rows=Object.entries(inputs).map(([instrument,values])=>{const history=referenceSeries(values);return {...frameFromSeries(instrument,history,ECB_FEED_SOURCE),collected_at,history};});
 const weekly={schema:POSITIONING_SCHEMA,collected_at,source_urls:['https://publicreporting.cftc.gov/resource/gpe5-46if.json'],instruments:Object.fromEntries(['USDJPY','EURUSD','GBPUSD'].map(pair=>[pair,Array.from({length:53},(_,i)=>({date:new Date(Date.parse('2026-10-06')-(52-i)*7*DAY).toISOString().slice(0,10),oi:1000,asset:{long:100,short:80},leveraged:{long:150,short:120}}))]))};
 const gold={schema:'CASCADE_CFTC_CONTEXT_1',formula_version:FORMULA_VERSION,instrument:'XAUUSD',report_date:'2026-10-06',open_interest:10000,spec_long:1000,spec_short:200,spec_net:800,net_oi:0.08,cot_bias:Number(Math.tanh(0.08/0.18).toFixed(6)),source_dataset_id:'CFTC_DISAGG_FUTURES_ONLY_WEEKLY',report_type:'FutOnly',source_record_id:'261006088691F',trading_signal:'DISABLED',source_url:'https://publicreporting.cftc.gov/resource/72hh-3qpy.json'};
 return {schema:FEED_SCHEMA,generated_at:collected_at,interval_ms:FEED_INTERVAL,outcomes:Object.fromEntries(['ecb','cftc_fx','gold'].map(key=>[key,{state:'ready',checked_at:collected_at}])),reference_inputs:inputs,weekly,observatory:{schema:'CASCADE_OBSERVATORY_1',formula_version:FORMULA_VERSION,generated_at:collected_at,rows,cftc:{XAUUSD:gold},sources:{ecb:{status:'available',reference_date:'2026-10-13',collected_at},cftc:{status:'available',report_date:'2026-10-06',collected_at}}}};
};
const oilFixture=()=>({schema:'PUBLIC_OIL_1',generated_at:collected_at,series:Object.fromEntries(Object.entries(OIL_SOURCES).map(([key,source])=>[key,{state:'ready',checked_at:collected_at,collected_at,source_url:source.url,unit:source.unit,release_date:'2026-10-07',next_release_date:'2026-10-15',rows:key==='inventory'?[{date:'2026-09-25',value:427320},{date:'2026-10-02',value:424134}]:[{date:'2026-10-05',value:100},{date:'2026-10-06',value:101}]}]))});
const commodityFixture=()=>({schema:'PUBLIC_COMMODITIES_1',generated_at:collected_at,instruments:Object.fromEntries(Object.entries(COMMODITY_CONTRACTS).map(([asset,contract])=>[asset,{state:'ready',checked_at:collected_at,collected_at,source_url:'https://publicreporting.cftc.gov/resource/72hh-3qpy.json',contract,rows:Array.from({length:156},(_,i)=>({date:new Date(Date.parse('2026-10-06')-(155-i)*7*DAY).toISOString().slice(0,10),open_interest:1000,groups:{producer:{long:100,short:100,spread:0},swap:{long:100,short:100,spread:20},managed:{long:200,short:100,spread:30},other:{long:100,short:100,spread:10}}}))}]))});
const stamp=collected_at;
function ready(){
 const bundles=[fixture(),oilFixture(),commodityFixture()],[feed,oil,commodities]=bundles;
 for(const b of bundles)b.generated_at=stamp;
 for(const s of Object.values(feed.outcomes)){s.state='ready';s.checked_at=stamp;}
 feed.observatory.generated_at=feed.observatory.sources.ecb.collected_at=feed.observatory.sources.cftc.collected_at=feed.weekly.collected_at=stamp;
 for(const row of feed.observatory.rows)row.collected_at=stamp;
 for(const s of [...Object.values(oil.series),...Object.values(commodities.instruments)]){s.state='ready';s.checked_at=s.collected_at=stamp;}
 return bundles;
}

test('healthy data skips hourly collection until the six-hour boundary',()=>{
 assert.deepEqual(collectionReadiness(ready(),{now}),{needed:false,reasons:[]});
 assert.equal(collectionReadiness(ready(),{now:now+6*3600000-1}).needed,false);
 assert.equal(collectionReadiness(ready(),{now:now+6*3600000}).needed,true);
});
test('each retained or failed source requests immediate recovery without changing timestamps',()=>{
 for(const [index,section,key] of [[0,'outcomes','ecb'],[0,'outcomes','cftc_fx'],[0,'outcomes','gold'],[1,'series','wti'],[1,'series','brent'],[1,'series','inventory'],[2,'instruments','gold'],[2,'instruments','oil']]){
  const b=ready();b[index][section][key].state=index===0?'failed':'retained';const before=JSON.stringify(b);
  assert.equal(collectionReadiness(b,{now:now+1000}).needed,true,key);
  assert.equal(JSON.stringify(b),before,'readiness must not stamp or modify data');
 }
});
test('fresh envelopes cannot conceal old source checks, observations or invalid structure',()=>{
 let b=ready();b[0].weekly.collected_at=new Date(now-9*3600000).toISOString();
 assert.ok(collectionReadiness(b,{now}).reasons.some(s=>s.includes('successful source check')));
 b=ready();for(const s of Object.values(b[1].series)){s.rows=s.rows.map(row=>({...row,date:new Date(Date.parse(row.date)-30*DAY).toISOString().slice(0,10)}));s.release_date=new Date(Date.parse(s.release_date)-30*DAY).toISOString().slice(0,10);s.next_release_date=new Date(Date.parse(s.next_release_date)-30*DAY).toISOString().slice(0,10);}
 assert.equal(validateOil(b[1],{now}),b[1],'stale oil fixture remains structurally valid with distinct dates');
 assert.equal(collectionReadiness(b,{now}).needed,true);
 b=ready();b[2].instruments.gold.checked_at=new Date(now-9*3600000).toISOString();b[2].instruments.gold.collected_at=b[2].instruments.gold.checked_at;
 assert.ok(collectionReadiness(b,{now}).reasons.some(s=>s.includes('heartbeat')));
 b=ready();b[0]=null;assert.equal(collectionReadiness(b,{now}).needed,true);
});

function simulation(pushes,bundles){
 const calls=[];
 return {calls,readReplica:async()=>undefined,read:async()=>bundles,now:()=>now,prepare:async()=>({changed:false}),run:(program,args,options={})=>{
  calls.push({program,args,options});
  if(args.includes('push'))return pushes.shift()??1;
  if(args.includes('--quiet'))return 1;
  return 0;
 }};
}
test('normal publication stages only the public data files and never force pushes',async()=>{
 const s=simulation([0],ready());assert.equal(await publishData(s),'published');
 assert.deepEqual(s.calls.find(c=>c.args[0]==='add').args,['add','--',...PUBLISH_FILES]);
 assert.equal(s.calls.filter(c=>c.options.authenticated).length,1);
 assert.ok(s.calls.every(c=>!c.args.includes('--force')&&!c.args.includes('--force-with-lease')));
});
test('a rejected push accepts another collector healthy main without recollecting or overwriting',async()=>{
 const s=simulation([1],ready());assert.equal(await publishData(s),'already refreshed');
 assert.ok(s.calls.some(c=>c.args.join(' ')==='reset --hard origin/main'));
 assert.ok(!s.calls.some(c=>c.program==='npm'));
 assert.equal(s.calls.filter(c=>c.args.includes('push')).length,1);
});
test('a rejected push recollects against latest main and retries once with token-free collectors',async()=>{
 const stale=ready();stale[0].outcomes.ecb.state='failed';const s=simulation([1,0],stale);
 assert.equal(await publishData(s),'published');
 assert.deepEqual(s.calls.filter(c=>c.program==='npm').map(c=>c.args),[['test'],['run','refresh'],['test']]);
 assert.ok(s.calls.filter(c=>c.program==='npm').every(c=>!c.options.authenticated));
 assert.equal(s.calls.filter(c=>c.args.includes('push')).length,2);
});
test('persistent conflicts fail visibly after two normal pushes with latest main retained',async()=>{
 const stale=ready();stale[0].outcomes.gold.state='failed';const s=simulation([1,1],stale);
 await assert.rejects(()=>publishData(s),/rejected twice/);
 assert.equal(s.calls.filter(c=>c.args.includes('push')).length,2);
 assert.deepEqual(s.calls.at(-1).args,['reset','--hard','origin/main']);
});
test('both hourly writers guard canonical public main and share the safe publication path',async()=>{
 for(const [name,minute] of [['refresh',23],['watchdog',53]]){
  const text=await readFile(new URL('../.github/workflows/'+name+'.yml',import.meta.url),'utf8');
  for(const expected of [`cron: '${minute} * * * *'`,"github.repository == 'nkis-works/cascade-public-data'",'github.event.repository.private == false',"github.ref == 'refs/heads/main'",'runs-on: ubuntu-latest','ref: main','persist-credentials: false','group: cascade-public-data-writer','cancel-in-progress: false','run: node scripts/feed-operations.mjs publish',"if: steps.readiness.outputs.needed == 'true'",'run: npm run refresh','run: npm test'])assert.ok(text.includes(expected),name+': '+expected);
  assert.equal((text.match(/GH_TOKEN:/g)||[]).length,1);
  assert.ok(!/cache:|upload-artifact|secrets\.|--force/.test(text));
 }
});

test('conflict recovery rechecks latest replica slot even when another collector restored healthy data',async()=>{
 const s=simulation([1,0],ready());let prepared=0;
 s.prepare=async()=>{prepared++;return {changed:true};};
 assert.equal(await publishData(s),'published');assert.equal(prepared,1);
 assert.ok(!s.calls.some(c=>c.program==='npm'));
 assert.equal(s.calls.filter(c=>c.args.includes('push')).length,2);
});
test('unchanged publication needs no commit or publishing token',async()=>{
 const s=simulation([],ready()),run=s.run;
 s.run=(program,args,options)=>args.includes('--quiet')?0:run(program,args,options);
 assert.equal(await publishData(s),'unchanged');
 assert.ok(!s.calls.some(c=>c.args.includes('commit')||c.options.authenticated));
});
test('a second conflict is successful when another writer has completed recovery',async()=>{
 const stale=ready();stale[0].outcomes.ecb.state='failed';const s=simulation([1,1],stale);let reads=0;
 s.read=async()=>++reads===1?stale:ready();
 assert.equal(await publishData(s),'already refreshed');
 assert.equal(s.calls.filter(c=>c.args.includes('push')).length,2);
});

function markerAt(published_at){
 return {schema:'PUBLIC_MARKET_REPLICA_1',repository:'nkis-works/cascade-public-data',slot:Math.floor(Date.parse(published_at)/FEED_INTERVAL),published_at,files:Object.fromEntries(['feed','oil','commodities'].map(name=>[name,{path:'/data/'+name+'.json',sha256:'a'.repeat(64),generated_at:published_at}]))};
}
function checkedAt(value){
 const bundles=ready(),[feed,oil,commodities]=bundles;
 for(const b of bundles)b.generated_at=value;
 for(const s of Object.values(feed.outcomes))s.checked_at=value;
 feed.observatory.generated_at=feed.observatory.sources.ecb.collected_at=feed.observatory.sources.cftc.collected_at=feed.weekly.collected_at=value;
 for(const row of feed.observatory.rows)row.collected_at=value;
 for(const s of [...Object.values(oil.series),...Object.values(commodities.instruments)])s.checked_at=s.collected_at=value;
 return bundles;
}
test('UTC replica slot gating recovers 01/07 collection timing before publishing the 06:23 replica',()=>{
 const at=Date.parse('2026-10-14T06:23:00.000Z'),old=checkedAt('2026-10-14T01:00:00.000Z'),replica=markerAt('2026-10-14T00:23:00.000Z');
 assert.equal(collectionReadiness(old,{now:at}).needed,false,'ordinary six-hour interval is not due yet');
 assert.ok(collectionReadiness(old,{now:at,replica}).reasons.some(s=>s.includes('current-slot collection')));
 assert.equal(collectionReadiness(old,{now:at,replica:null}).needed,true,'missing replica also needs current-slot data');
 const fresh=checkedAt('2026-10-14T06:22:00.000Z');
 assert.equal(collectionReadiness(fresh,{now:at,replica}).needed,false,'already current-slot data can publish without another collection');
 assert.equal(collectionReadiness(fresh,{now:at,replica:null}).needed,false);
});
test('invalid and future replica markers fail explicitly instead of allowing replacement',()=>{
 for(const mutate of [m=>{m.slot++;},m=>{m.published_at=new Date(now+1).toISOString();},m=>{m.schema='unknown';},m=>{m.files.feed.path='/private';},m=>{m.files.oil.sha256='invalid';}]){
  const replica=markerAt(stamp);mutate(replica);
  assert.throws(()=>collectionReadiness(ready(),{now,replica}),/Invalid/);
 }
});
test('real Git compare-and-swap rejects stale writer and retains another collector newer head',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'market-data-cas-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const origin=path.join(root,'origin.git'),writer=path.join(root,'writer'),peer=path.join(root,'peer');
 function git(cwd,args,{allowFailure=false}={}){
  const result=spawnSync('git',args,{cwd,encoding:'utf8'});
  if(result.error)throw result.error;
  if(result.status&&!allowFailure)throw Error(result.stderr||'git failed');
  return result;
 }
 await mkdir(writer);git(root,['init','--bare',origin]);git(writer,['init','--initial-branch=main']);
 for(const cwd of [writer]){git(cwd,['config','user.name','CAS test']);git(cwd,['config','user.email','cas@example.invalid']);}
 const base=checkedAt(new Date(now-2*3600000).toISOString());
 for(const [i,file]of DATA_FILES.entries()){await mkdir(path.dirname(path.join(writer,file)),{recursive:true});await writeFile(path.join(writer,file),JSON.stringify(base[i]));}
 for(const file of PUBLISH_FILES.filter(file=>!DATA_FILES.includes(file))){await mkdir(path.dirname(path.join(writer,file)),{recursive:true});await writeFile(path.join(writer,file),'fixture\n');}
 git(writer,['add','--',...PUBLISH_FILES]);git(writer,['commit','-m','Initial public fixture']);git(writer,['remote','add','origin',origin]);git(writer,['push','origin','HEAD:main']);git(root,['clone','--branch','main',origin,peer]);
 git(peer,['config','user.name','Other collector']);git(peer,['config','user.email','peer@example.invalid']);
 const local=checkedAt(new Date(now-3600000).toISOString());await writeFile(path.join(writer,DATA_FILES[0]),JSON.stringify(local[0]));
 const newer=JSON.stringify(ready()[0]);await writeFile(path.join(peer,DATA_FILES[0]),newer);git(peer,['add','--',DATA_FILES[0]]);git(peer,['commit','-m','Newer validated collector']);
 const peerHead=git(peer,['rev-parse','HEAD']).stdout.trim();let rejectedHead=null,pushes=0;
 const run=(program,args,options={})=>{
  assert.equal(program,'git','healthy competing collection must not run npm');
  const clean=[];for(let i=0;i<args.length;i++){if(args[i]==='-c'){i++;continue;}clean.push(args[i]);}
  if(clean[0]==='push'&&pushes++===0){rejectedHead=git(writer,['rev-parse','HEAD']).stdout.trim();git(peer,['push','origin','HEAD:main']);}
  return git(writer,clean,options).status;
 };
 const result=await publishData({run,read:()=>Promise.all(DATA_FILES.map(async file=>JSON.parse(await readFile(path.join(writer,file),'utf8')))),readReplica:async()=>undefined,prepare:async()=>({changed:false}),now:()=>now});
 assert.equal(result,'already refreshed');assert.equal(pushes,1);
 assert.equal(git(origin,['rev-parse','refs/heads/main']).stdout.trim(),peerHead);
 assert.equal(git(writer,['rev-parse','HEAD']).stdout.trim(),peerHead);
 assert.equal(await readFile(path.join(writer,DATA_FILES[0]),'utf8'),newer);
 assert.equal(git(origin,['show','main:'+DATA_FILES[0]]).stdout,newer);
 assert.equal(git(writer,['merge-base','--is-ancestor',rejectedHead,peerHead],{allowFailure:true}).status,1,'rejected stale commit must not enter newer head history');
});
