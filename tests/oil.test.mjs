import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {parseOilHtml,collectOil} from '../scripts/collect-oil.mjs';
import {OIL_SOURCES,OIL_FEED_URL,validateOil,oilSeriesHealth,oilChange,oilSpread,loadOil} from '../src/oil-data.js';
const now=Date.parse('2026-10-14T16:00:00Z'),stamp=new Date(now).toISOString();
const html=Object.fromEntries(await Promise.all(Object.keys(OIL_SOURCES).map(async key=>[key,await readFile(new URL('fixtures/oil/'+key+'.html',import.meta.url),'utf8')])));
const fixture=()=>({schema:'PUBLIC_OIL_1',generated_at:stamp,series:Object.fromEntries(Object.entries(OIL_SOURCES).map(([key,s])=>[key,{state:'ready',checked_at:stamp,collected_at:stamp,source_url:s.url,unit:s.unit,...parseOilHtml(html[key],key)}]))});
test('EIA official table columns map dates and units without filling holidays',()=>{
 const bundle=validateOil(fixture(),{now});
 assert.deepEqual(bundle.series.wti.rows.at(-1),{date:'2026-10-06',value:96.24});
 assert.deepEqual(bundle.series.inventory.rows.at(-1),{date:'2026-10-02',value:424134});
 assert.equal(bundle.series.wti.release_date,'2026-10-07');assert.equal(bundle.series.wti.next_release_date,'2026-10-15');
 assert.ok(!bundle.series.wti.rows.some(r=>r.date==='2026-10-07'));
 assert.deepEqual(oilSpread(bundle),{date:'2026-10-06',value:125.44-96.24});
 assert.equal(oilChange(bundle.series.inventory).change,-3186);
});
test('parser rejects changed identity, columns, dates, missing releases and malformed numbers',()=>{
 for(const change of [s=>s.replace('Dollars per Barrel','unknown'),s=>s.replace('Cushing, OK','Other'),s=>s.replace('Release Date: 10/7/2026',''),s=>s.replace('96.24','96x24'),s=>s.replace('2026 Oct- 5','2026 Oct- 6'),s=>s.replace('Oct- 9','Oct- 8'),s=>s.replace("<td class='B3'>96.24</td>",'')])assert.throws(()=>parseOilHtml(change(html.wti),'wti'));
 assert.throws(()=>parseOilHtml(html.inventory.replace('10/02','11/02'),'inventory'));
 assert.throws(()=>parseOilHtml('<html>blocked</html>','wti'));
});
test('negative WTI and zero are valid price observations; use absolute changes, never log returns',()=>{
 const bundle=fixture(),s=bundle.series.wti;s.rows=s.rows.slice(-3);s.rows[0].value=-36.98;s.rows[1].value=0;s.rows[2].value=10;
 assert.equal(validateOil(bundle,{now}),bundle);assert.equal(oilChange(s).change,10);
 bundle.series.brent.rows=bundle.series.brent.rows.slice(0,-1);const spread=oilSpread(bundle);
 assert.ok(spread.date<bundle.series.wti.rows.at(-1).date,'spread must align actual observation dates');
});
test('schema rejects future, duplicate, reversed, invented source and incorrect inventory units',()=>{
 const mutations=[b=>b.series.wti.rows.at(-1).value=NaN,b=>b.series.wti.rows.at(-1).date='2026-10-31',b=>b.series.wti.rows.at(-1).date=b.series.wti.rows.at(-2).date,b=>b.series.wti.source_url='https://unknown.test',b=>b.series.inventory.unit='million_barrels',b=>b.series.inventory.rows.at(-1).value=-1,b=>b.series.wti.next_release_date='2030-10-15',b=>b.series.wti.release_date='2026-02-30',b=>b.generated_at='2099-01-01T00:00:00Z',b=>b.series.wti.checked_at='1900-01-01T00:00:00Z'];
 for(const mutate of mutations){const b=fixture();mutate(b);assert.throws(()=>validateOil(b,{now}));}
 const before=fixture(),after=fixture();after.series.wti.rows.pop();assert.throws(()=>validateOil(after,{now,previous:before}));
});
test('freshness uses EIA next release and grace period, while stopped collection is a separate warning',()=>{
 const s=fixture().series.inventory;
 assert.equal(oilSeriesHealth(s,{now}).warning,false,'holiday-delayed scheduled report remains valid');
 const stopped=oilSeriesHealth(s,{now:now+2*86400000});assert.equal(stopped.delayed,true);assert.equal(stopped.stale,false);
 assert.equal(oilSeriesHealth(s,{now:Date.parse('2026-10-19')}).stale,true);
 assert.equal(oilSeriesHealth({...s,state:'retained'},{now}).retained,true);
});
test('failed or invalid EIA series retains its original date and success timestamp; other series publish',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oil-')),file=join(dir,'oil.json');
 const fetcher=async url=>new Response(html[Object.keys(OIL_SOURCES).find(k=>OIL_SOURCES[k].url===url)],{headers:{'content-type':'text/html'}});
 try{
  await collectOil({file,now,fetcher});const before=JSON.parse(await readFile(file));
  await collectOil({file,now:now+3600000,fetcher:async url=>url===OIL_SOURCES.wti.url?new Response('<html>changed</html>',{headers:{'content-type':'text/html'}}):fetcher(url)});
  const after=JSON.parse(await readFile(file));assert.equal(after.series.wti.state,'retained');assert.equal(after.series.wti.collected_at,before.series.wti.collected_at);assert.deepEqual(after.series.wti.rows,before.series.wti.rows);assert.equal(after.series.brent.state,'ready');assert.equal(after.series.brent.checked_at,new Date(now+3600000).toISOString());
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('browser fetch allows only fixed public snapshots, rejects malformed/oversized data, and marks fallback',async()=>{
 const data=fixture(),calls=[];const response=()=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 const fresh=await loadOil(async url=>{calls.push(url);return response();},{now});assert.equal(fresh.mode,'automatic');assert.deepEqual(calls,[OIL_FEED_URL]);
 calls.length=0;const old=await loadOil(async url=>{calls.push(url);return url===OIL_FEED_URL?new Response('bad',{status:503}):response();},{now});assert.equal(old.mode,'fallback');assert.deepEqual(calls,[OIL_FEED_URL,'/data/oil.json']);
 await assert.rejects(()=>loadOil(async()=>new Response('x'.repeat(160000),{headers:{'content-type':'application/json'}})));
 await assert.rejects(()=>loadOil(async()=>new Response('{}',{headers:{'content-type':'application/json'}})));
});
