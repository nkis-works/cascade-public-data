import test from 'node:test';
import assert from 'node:assert/strict';
import {feedHealth,oilHealth,remoteHealth} from '../scripts/feed-health.mjs';
import {OIL_SOURCES,OIL_FEED_URL} from '../src/oil-data.js';
import {FEED_SCHEMA,FEED_INTERVAL,ECB_FEED_SOURCE} from '../src/feed-contract.js';
import {referenceSeries,frameFromSeries,FORMULA_VERSION} from '../src/reference-math.js';
import {POSITIONING_SCHEMA} from '../src/positioning.js';
// Synthetic fixed test data. Runtime source outages must never make unit tests
// block publication or recovery of the other sources.
const collected_at='2026-10-14T07:49:30.319Z',now=Date.parse(collected_at),DAY=86400000;
const fixture=()=>{
 const inputs=Object.fromEntries(Object.entries({EURUSD:1.1,GBPUSD:1.3,USDJPY:150}).map(([pair,rate])=>[pair,Array.from({length:81},(_,i)=>[new Date(Date.parse('2026-10-13')-(80-i)*DAY).toISOString().slice(0,10),rate])]));
 const rows=Object.entries(inputs).map(([instrument,values])=>{const history=referenceSeries(values);return {...frameFromSeries(instrument,history,ECB_FEED_SOURCE),collected_at,history};});
 const weekly={schema:POSITIONING_SCHEMA,collected_at,source_urls:['https://publicreporting.cftc.gov/resource/gpe5-46if.json'],instruments:Object.fromEntries(['USDJPY','EURUSD','GBPUSD'].map(pair=>[pair,Array.from({length:53},(_,i)=>({date:new Date(Date.parse('2026-10-06')-(52-i)*7*DAY).toISOString().slice(0,10),oi:1000,asset:{long:100,short:80},leveraged:{long:150,short:120}}))]))};
 const gold={schema:'CASCADE_CFTC_CONTEXT_1',formula_version:FORMULA_VERSION,instrument:'XAUUSD',report_date:'2026-10-06',open_interest:10000,spec_long:1000,spec_short:200,spec_net:800,net_oi:0.08,cot_bias:Number(Math.tanh(0.08/0.18).toFixed(6)),source_dataset_id:'CFTC_DISAGG_FUTURES_ONLY_WEEKLY',report_type:'FutOnly',source_record_id:'261006088691F',trading_signal:'DISABLED',source_url:'https://publicreporting.cftc.gov/resource/72hh-3qpy.json'};
 return {schema:FEED_SCHEMA,generated_at:collected_at,interval_ms:FEED_INTERVAL,outcomes:Object.fromEntries(['ecb','cftc_fx','gold'].map(key=>[key,{state:'ready',checked_at:collected_at}])),reference_inputs:inputs,weekly,observatory:{schema:'CASCADE_OBSERVATORY_1',formula_version:FORMULA_VERSION,generated_at:collected_at,rows,cftc:{XAUUSD:gold},sources:{ecb:{status:'available',reference_date:'2026-10-13',collected_at},cftc:{status:'available',report_date:'2026-10-06',collected_at}}}};
};
const oilFixture=()=>({schema:'PUBLIC_OIL_1',generated_at:collected_at,series:Object.fromEntries(Object.entries(OIL_SOURCES).map(([key,source])=>[key,{state:'ready',checked_at:collected_at,collected_at,source_url:source.url,unit:source.unit,release_date:'2026-10-07',next_release_date:'2026-10-15',rows:key==='inventory'?[{date:'2026-09-25',value:427320},{date:'2026-10-02',value:424134}]:[{date:'2026-10-05',value:100},{date:'2026-10-06',value:101}]}]))});
test('health uses observation dates and source outcomes rather than successful job status',()=>{
 const b=fixture();for(const source of Object.values(b.outcomes))source.state='ready';
 assert.equal(feedHealth(b,{now}).healthy,true);
 b.outcomes.cftc_fx.state='failed';const result=feedHealth(b,{now});
 assert.equal(result.healthy,false);assert.ok(result.issues.some(issue=>issue.includes('CFTC currency futures')));
 assert.deepEqual(result.observation_dates,feedHealth(fixture(),{now}).observation_dates);
});
test('a structurally valid but stopped collector is unhealthy after 24 hours',()=>{
 const b=fixture();for(const source of Object.values(b.outcomes))source.state='ready';
 const result=feedHealth(b,{now:now+86400001});
 assert.equal(result.healthy,false);assert.ok(result.issues.some(issue=>issue.startsWith('Collector checks')));
 assert.ok(!feedHealth(b,{now:now+86400000}).issues.some(issue=>issue.startsWith('Collector checks')));
});
test('freshly stamped bundles cannot conceal old observations or missing sources',()=>{
 const b=fixture(),later=now+20*86400000;b.generated_at=new Date(later).toISOString();
 for(const source of Object.values(b.outcomes)){source.state='ready';source.checked_at=b.generated_at;}
 const result=feedHealth(b,{now:later});assert.equal(result.healthy,false);
 for(const source of ['ECB','CFTC currency futures','CFTC gold futures'])assert.ok(result.issues.some(issue=>issue.startsWith(source)&&issue.includes('observation date')));
 b.outcomes.gold.state='unavailable';assert.ok(feedHealth(b,{now:later}).issues.some(issue=>issue.includes('collection did not complete')));
});
test('normal Friday publication lag does not create false CFTC alarms',()=>{
 const b=fixture(),friday=Date.parse('2026-10-16T14:23:00.000Z');b.generated_at=new Date(friday).toISOString();
 for(const source of Object.values(b.outcomes))source.checked_at=b.generated_at;
 b.weekly.collected_at=b.observatory.generated_at=b.observatory.sources.ecb.collected_at=b.observatory.sources.cftc.collected_at=b.generated_at;
 for(const row of b.observatory.rows)row.collected_at=b.generated_at;
 assert.equal(feedHealth(b,{now:friday}).healthy,true);
 assert.ok(feedHealth(b,{now:Date.parse('2026-10-18T14:23:00.000Z')}).issues.some(issue=>issue.startsWith('CFTC currency futures')&&issue.includes('observation date')));
});
test('remote watchdog checks both validated feeds and five pages without sending credentials',async()=>{
 const b=fixture();for(const source of Object.values(b.outcomes))source.state='ready';let calls=0;
 const fetcher=async(url,options)=>{calls++;assert.ok(!options.headers.Authorization);assert.ok(!options.body);return new Response(url.includes('raw.githubusercontent.com')?JSON.stringify(url===OIL_FEED_URL?oilFixture():b):'<title>Market data</title><h1>Markets</h1>',{headers:{'content-type':url.includes('raw.githubusercontent.com')?'text/plain':'text/html'}});};
 const result=await remoteHealth({fetcher,now});assert.equal(result.healthy,true);assert.equal(calls,7);assert.equal(result.oil.healthy,true);
 const bad=await remoteHealth({now,sleep:async()=>{},fetcher:async url=>url.includes('raw.githubusercontent.com')?new Response(JSON.stringify(url===OIL_FEED_URL?oilFixture():b),{headers:{'content-type':'text/plain'}}):new Response('<title>Not found</title>',{headers:{'content-type':'text/html'}})});
 assert.equal(bad.healthy,false);assert.equal(bad.issues.length,5);
});

test('oil health validates schema and detects retained, delayed and stale series independently',()=>{
 const bundle=oilFixture();assert.equal(oilHealth(bundle,{now}).healthy,true);
 bundle.series.wti.state='retained';let result=oilHealth(bundle,{now});assert.equal(result.healthy,false);assert.ok(result.issues.some(issue=>issue.includes('WTI')&&issue.includes('retained')));
 const late=now+DAY+1;result=oilHealth(oilFixture(),{now:late});assert.ok(result.issues.some(issue=>issue.startsWith('EIA collector checks')));assert.equal(result.issues.filter(issue=>issue.includes('source check is delayed')).length,3);
 const stale=oilFixture(),staleNow=Date.parse('2026-10-19T12:00:00Z');stale.generated_at=new Date(staleNow).toISOString();for(const series of Object.values(stale.series))series.checked_at=stale.generated_at;
 result=oilHealth(stale,{now:staleNow});assert.equal(result.issues.filter(issue=>issue.includes('scheduled release is too old')).length,3);assert.ok(!result.issues.some(issue=>issue.includes('delayed')));
 const invalid=oilFixture();invalid.series.wti.source_url='https://untrusted.example';assert.throws(()=>oilHealth(invalid,{now}));
});
test('remote oil validation failures are visible while other feeds and pages remain healthy',async()=>{
 const visited=[];const result=await remoteHealth({now,fetcher:async(url,options)=>{visited.push(url);assert.ok(!options.headers.Authorization);assert.ok(!options.body);return new Response(url===OIL_FEED_URL?'{}':url.includes('raw.githubusercontent.com')?JSON.stringify(fixture()):'<title>Markets</title><h1>Markets</h1>',{headers:{'content-type':url.includes('raw.githubusercontent.com')?'text/plain':'text/html'}});}});
 assert.equal(result.healthy,false);assert.equal(result.feed.healthy,true);assert.equal(result.oil,null);assert.equal(result.issues.length,1);assert.ok(result.issues[0].startsWith('Published EIA oil data:'));
 assert.ok(visited.includes('https://cascade-public.pages.dev/tools/gold-check/'));assert.ok(visited.includes('https://cascade-public.pages.dev/markets/oil/'));
});
