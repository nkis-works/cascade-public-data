import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateCommodityPositions,commodityReading,commodityHealth,commodityWarnings,loadCommodityPositions,COMMODITY_FEED_URL} from '../src/commodity-positioning.js';
import {normalizeCFTC,collectCommodities,commoditySourceURL} from '../scripts/collect-commodities.mjs';
const fixture=JSON.parse(await readFile(new URL('./fixtures/commodity-cftc.json',import.meta.url)));
const now=Date.parse('2026-10-15T12:00:00Z'),stamp=new Date(now).toISOString();
function raw(contract='088691') {return Array.from({length:156},(_,i)=>{const date=new Date(Date.parse('2023-10-17')+i*7*86400000).toISOString().slice(0,10);return {...fixture,id:date.replaceAll('-','').slice(2)+contract+'F',cftc_contract_market_code:contract,report_date_as_yyyy_mm_dd:date+'T00:00:00.000'};});}
function bundle() {return {schema:'PUBLIC_COMMODITIES_1',generated_at:stamp,instruments:Object.fromEntries([['gold','088691'],['oil','067651']].map(([asset,contract])=>[asset,{state:'ready',checked_at:stamp,collected_at:stamp,source_url:commoditySourceURL(contract),contract,rows:normalizeCFTC(raw(contract),contract,{now})}]))};}
const clone=x=>structuredClone(x);
test('official fixture has exact participant counts and separate spreading',()=>{
 const row=normalizeCFTC(raw(),'088691',{now})[0];
 assert.equal(row.date,'2023-10-17');assert.equal(row.open_interest,439581);assert.deepEqual(row.groups.managed,{long:104708,short:89605,spread:39547});assert.deepEqual(row.groups.producer,{long:11737,short:41703,spread:0});
 assert.deepEqual(row.groups,{producer:{long:Number(fixture.prod_merc_positions_long),short:Number(fixture.prod_merc_positions_short),spread:0},swap:{long:Number(fixture.swap_positions_long_all),short:Number(fixture.swap__positions_short_all),spread:Number(fixture.swap__positions_spread_all)},managed:{long:Number(fixture.m_money_positions_long_all),short:Number(fixture.m_money_positions_short_all),spread:Number(fixture.m_money_positions_spread)},other:{long:Number(fixture.other_rept_positions_long),short:Number(fixture.other_rept_positions_short),spread:Number(fixture.other_rept_positions_spread)}});
});
test('reject wrong identity, missing field, combined, duplicate and future reports',()=>{
 for(const mutate of [r=>delete r[0].m_money_positions_spread,r=>r[0].id='wrong',r=>r[0].cftc_contract_market_code='067651',r=>r[0].futonly_or_combined='Combined',r=>r[1]={...r[0]},r=>{r[0].report_date_as_yyyy_mm_dd='2027-01-01T00:00:00.000';r[0].id='270101088691F';},r=>r[0].open_interest_all='1.2']){const rows=raw();mutate(rows);assert.throws(()=>normalizeCFTC(rows,'088691',{now}));}
});
test('strict schema, metadata, monotonic history, counts and source ownership',()=>{
 const valid=bundle();assert.equal(validateCommodityPositions(valid,{now}),valid);
 for(const mutate of [b=>b.schema='bad',b=>b.generated_at='2027-01-01T00:00:00.000Z',b=>b.generated_at='2026-02-30T00:00:00.000Z',b=>b.instruments.gold.contract='bad',b=>b.instruments.gold.rows[0].groups.managed.long=-1,b=>delete b.instruments.gold.rows[0].groups.other,b=>b.instruments.gold.rows.reverse(),b=>b.instruments.gold.rows.pop(),b=>b.instruments.gold.source_url='https://example.com/resource/72hh-3qpy.json',b=>b.instruments.gold.collected_at='2027-01-01T00:00:00.000Z']){const changed=clone(valid);mutate(changed);assert.throws(()=>validateCommodityPositions(changed,{now}));}
 const older=clone(valid);older.instruments.gold.rows.forEach(r=>r.date=new Date(Date.parse(r.date)-7*86400000).toISOString().slice(0,10));assert.throws(()=>validateCommodityPositions(older,{now,previous:valid}));
});
test('reading gives exact differences, minimum 52 earlier samples and no future values',()=>{
 const series=bundle().instruments.gold;const row=series.rows[52],prior=series.rows[51];
 row.groups.managed={long:200,short:100,spread:30};prior.groups.managed={long:180,short:110,spread:20};
 const reading=commodityReading(series,{date:row.date});assert.equal(reading.net,100);assert.equal(reading.netOi,100/row.open_interest);assert.equal(reading.deltaLong,20);assert.equal(reading.deltaShort,-10);assert.equal(reading.deltaNet,30);assert.equal(reading.deltaSpread,10);assert.equal(reading.gapDays,7);assert.equal(reading.sampleCount,52);assert.equal(reading.rank,100/52);assert.equal(commodityReading(series,{date:series.rows[51].date}).rank,null);
 const before=clone(reading);series.rows[53].groups.managed.long=100000;assert.deepEqual(commodityReading(series,{date:row.date}),before);assert.equal(reading.historyPrefix.at(-1).date,row.date);assert.equal(reading.historyPrefix.length,53);assert.ok(reading.historyPrefix.slice(0,-1).every(r=>r.date<row.date));
});
test('report gaps remain visible; report and check ages warn separately',()=>{
 const b=bundle(),s=b.instruments.gold;s.rows[60].date=new Date(Date.parse(s.rows[60].date)+86400000).toISOString().slice(0,10);
 assert.equal(commodityReading(s,{date:s.rows[60].date}).gapDays,8);assert.equal(commodityReading(s,{date:s.rows[60].date}).gaps.length,1);
 assert.deepEqual(commodityHealth(s,{now}),{warning:false,delayed:false,stale:false,retained:false});
 s.checked_at=s.collected_at='2026-10-13T12:00:00.000Z';assert.equal(commodityHealth(s,{now}).delayed,true);assert.equal(commodityHealth(s,{now}).stale,false);
 assert.equal(commodityWarnings(b,{now:now+14*86400000}).filter(w=>w.code==='stale-report').length,2);
});
function response(value){return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});}
test('collector uses bounded pagination, explicit futures selection and retains partial failure',async()=>{
 const previous=bundle();let calls=0;
 const result=await collectCommodities({previous,now:now+1000,fetcher:async url=>{calls++;const u=new URL(url),where=u.searchParams.get('$where');assert.match(where,/futonly_or_combined='FutOnly'/);assert.equal(u.searchParams.get('$limit'),'100');if(where.includes('067651'))return new Response('no',{status:400});const offset=Number(u.searchParams.get('$offset'));return response(raw().reverse().slice(offset,offset+100));}});
 assert.equal(calls,3);assert.equal(result.instruments.gold.state,'ready');assert.equal(result.instruments.oil.state,'retained');assert.equal(result.instruments.oil.collected_at,previous.instruments.oil.collected_at);assert.equal(result.instruments.oil.checked_at,new Date(now+1000).toISOString());assert.deepEqual(result.instruments.oil.rows,previous.instruments.oil.rows);
});
test('collector retains when source is older, never regress latest report',async()=>{
 const previous=bundle();const rows=raw();rows.forEach(r=>{const d=new Date(Date.parse(r.report_date_as_yyyy_mm_dd+'Z')-7*86400000).toISOString().slice(0,10);r.report_date_as_yyyy_mm_dd=d+'T00:00:00.000';r.id=d.replaceAll('-','').slice(2)+'088691F';});
 const result=await collectCommodities({previous,now,fetcher:async url=>{const u=new URL(url);return response(rows.reverse().slice(Number(u.searchParams.get('$offset')),Number(u.searchParams.get('$offset'))+100));}});assert.equal(result.instruments.gold.state,'retained');assert.equal(result.instruments.oil.state,'retained');
});
test('loader approved URL, bounded body, local fallback and retained previous',async()=>{
 const b=bundle(),urls=[];const loaded=await loadCommodityPositions(async(url,options)=>{urls.push(url);assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');if(url===COMMODITY_FEED_URL)return new Response('x'.repeat(300001));return response(b);},{now});assert.equal(loaded.mode,'fallback');assert.deepEqual(urls,[COMMODITY_FEED_URL,'/data/commodities.json']);
 assert.equal((await loadCommodityPositions(async()=>response(b),{now})).mode,'automatic');assert.equal((await loadCommodityPositions(async()=>new Response('',{status:500}),{now,previous:b})).mode,'retained');await assert.rejects(()=>loadCommodityPositions(async()=>new Response('',{status:500}),{now}));
});
test('frozen CFTC fixture yields 156 unique reports per contract without depending on the operational snapshot',()=>{const stable=bundle();validateCommodityPositions(stable,{now});for(const series of Object.values(stable.instruments)){assert.equal(series.rows.length,156);assert.equal(new Set(series.rows.map(r=>r.date)).size,156);}});
test('history includes selected row within window; midrank ties use only earlier reports',()=>{
 const b=bundle(),s=b.instruments.gold;
 for(const row of s.rows){row.open_interest=1000;row.groups={producer:{long:100,short:100,spread:0},swap:{long:100,short:100,spread:20},managed:{long:200,short:100,spread:30},other:{long:100,short:100,spread:10}};}
 validateCommodityPositions(b,{now});
 const flat=commodityReading(s);assert.equal(flat.rank,50);assert.equal(flat.historyPrefix.length,156);assert.equal(flat.sampleCount,155);assert.equal(flat.historyPrefix.at(-1).date,flat.date);
 for(let i=0;i<13;i++)s.rows[i].groups.managed.long=150;
 for(let i=39;i<52;i++)s.rows[i].groups.managed.long=250;
 const mixed=commodityReading(s,{date:s.rows[52].date});assert.equal(mixed.rank,50);assert.equal(mixed.sampleCount,52);assert.equal(mixed.historyPrefix.length,53);
 assert.equal(commodityReading(s,{date:s.rows[52].date,window:52}).rank,null);
 const one=commodityReading(s,{date:s.rows[52].date,window:1});assert.deepEqual(one.historyPrefix,[s.rows[52]]);assert.equal(one.sampleCount,0);assert.equal(one.rank,null);
 s.rows[52].open_interest=1000000000000000;s.rows[52].groups.managed={long:100000000000001,short:1,spread:0};
 const precision=commodityReading(s,{date:s.rows[52].date});assert.equal(precision.netOi,0.1);assert.equal(precision.rank,50);
 // An independently represented rational value differs by less than tolerance.
 s.rows[52].groups.managed.long+=1;assert.equal(commodityReading(s,{date:s.rows[52].date}).rank,50);
});
test('directional plus spreading positions cannot exceed open interest individually or in aggregate',()=>{
 const template=bundle();const base={producer:{long:100,short:100,spread:0},swap:{long:200,short:200,spread:50},managed:{long:200,short:200,spread:50},other:{long:300,short:300,spread:100}};
 for(const row of template.instruments.gold.rows){row.open_interest=1000;row.groups=clone(base);}
 assert.equal(validateCommodityPositions(template,{now}),template); // Both reported sides exactly equal OI.
 template.instruments.gold.rows[0].groups.other.long=200;validateCommodityPositions(template,{now}); // Nonreportable positions may fill the remainder.
 for(const change of [
  r=>{for(const g of Object.values(r.groups))Object.assign(g,{long:0,short:0,spread:0});r.groups.managed={long:995,short:0,spread:10};},
  r=>{for(const g of Object.values(r.groups))Object.assign(g,{long:0,short:0,spread:0});r.groups.managed={long:0,short:995,spread:10};},
  r=>{for(const g of Object.values(r.groups))Object.assign(g,{long:300,short:0,spread:0});},
  r=>{for(const g of Object.values(r.groups))Object.assign(g,{long:0,short:300,spread:0});},
  r=>{for(const [key,g] of Object.entries(r.groups))Object.assign(g,{long:200,short:0,spread:key==='producer'?0:100});},
  r=>{for(const [key,g] of Object.entries(r.groups))Object.assign(g,{long:0,short:200,spread:key==='producer'?0:100});}
 ]){const b=clone(template);change(b.instruments.gold.rows[0]);assert.throws(()=>validateCommodityPositions(b,{now}));}
});
test('browser loader accepts JSON and raw-only plain text, rejects HTML, missing type and malformed UTF-8',async()=>{
 const b=bundle();const text=JSON.stringify(b);
 assert.equal((await loadCommodityPositions(async()=>new Response(text,{headers:{'content-type':'text/plain; charset=utf-8'}}),{now})).mode,'automatic');
 const fallback=await loadCommodityPositions(async url=>url===COMMODITY_FEED_URL?new Response(text,{headers:{'content-type':'text/html'}}):response(b),{now});assert.equal(fallback.mode,'fallback');
 for(const type of ['text/html','application/octet-stream','application/problem+json'])await assert.rejects(()=>loadCommodityPositions(async()=>new Response(text,{headers:{'content-type':type}}),{now}));
 await assert.rejects(()=>loadCommodityPositions(async url=>url===COMMODITY_FEED_URL?new Response('',{status:500}):new Response(text,{headers:{'content-type':'text/plain'}}),{now}));
 await assert.rejects(()=>loadCommodityPositions(async()=>new Response(new TextEncoder().encode(text)),{now}));
 const invalid=Buffer.concat([Buffer.from('{"note":"'),Buffer.from([255]),Buffer.from('",'+text.slice(1))]);
 await assert.rejects(()=>loadCommodityPositions(async()=>new Response(invalid,{headers:{'content-type':'application/json'}}),{now}));
});
