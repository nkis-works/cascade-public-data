import test from 'node:test';
import {createHash} from 'node:crypto';
import {REPLICA_ORIGIN} from '../scripts/prepare-backup.mjs';
import assert from 'node:assert/strict';
import {feedHealth,oilHealth,commodityFeedHealth,remoteHealth,replicaHealth} from '../scripts/feed-health.mjs';
import {OIL_SOURCES,OIL_FEED_URL} from '../src/oil-data.js';
import {COMMODITY_CONTRACTS,COMMODITY_FEED_URL} from '../src/commodity-positioning.js';
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
const commodityFixture=()=>({schema:'PUBLIC_COMMODITIES_1',generated_at:collected_at,instruments:Object.fromEntries(Object.entries(COMMODITY_CONTRACTS).map(([asset,contract])=>[asset,{state:'ready',checked_at:collected_at,collected_at,source_url:'https://publicreporting.cftc.gov/resource/72hh-3qpy.json',contract,rows:Array.from({length:156},(_,i)=>({date:new Date(Date.parse('2026-10-06')-(155-i)*7*DAY).toISOString().slice(0,10),open_interest:1000,groups:{producer:{long:100,short:100,spread:0},swap:{long:100,short:100,spread:20},managed:{long:200,short:100,spread:30},other:{long:100,short:100,spread:10}}}))}]))});
const publicFixture=url=>url===OIL_FEED_URL?oilFixture():url===COMMODITY_FEED_URL?commodityFixture():fixture();
const hash=text=>createHash('sha256').update(text).digest('hex');
function replicaFixture(bundle=fixture(),published_at=collected_at){
 const text=JSON.stringify(bundle);
 const marker={schema:'PUBLIC_MARKET_REPLICA_1',repository:'nkis-works/cascade-public-data',slot:Math.floor(Date.parse(published_at)/FEED_INTERVAL),published_at,files:Object.fromEntries(['feed','oil','commodities'].map(name=>[name,{path:'/data/'+name+'.json',sha256:name==='feed'?hash(text):'a'.repeat(64),generated_at:bundle.generated_at}]))};
 return {text,marker};
}
function replicaResponse(url,{text,marker}=replicaFixture(),headers={}){
 if(!url.startsWith(REPLICA_ORIGIN+'/'))return null;
 return new Response(url.endsWith('/replica.json')?JSON.stringify(marker):text,{headers:{'content-type':'application/json','access-control-allow-origin':'*',...headers}});
}
test('health uses observation dates and source outcomes rather than successful job status',()=>{
 const b=fixture();for(const source of Object.values(b.outcomes))source.state='ready';
 assert.equal(feedHealth(b,{now}).healthy,true);
 b.outcomes.cftc_fx.state='failed';const result=feedHealth(b,{now});
 assert.equal(result.healthy,false);assert.ok(result.issues.some(issue=>issue.includes('CFTC currency futures')));
 assert.deepEqual(result.observation_dates,feedHealth(fixture(),{now}).observation_dates);
});
test('a structurally valid but stopped collector is unhealthy after eight hours',()=>{
 const b=fixture();for(const source of Object.values(b.outcomes))source.state='ready';
 const result=feedHealth(b,{now:now+8*3600000+1});
 assert.equal(result.healthy,false);assert.ok(result.issues.some(issue=>issue.startsWith('Collector checks')));
 assert.ok(!feedHealth(b,{now:now+8*3600000}).issues.some(issue=>issue.startsWith('Collector checks')));
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
test('remote watchdog checks three feeds, six pages and two replica files without credentials',async()=>{
 const b=fixture();for(const source of Object.values(b.outcomes))source.state='ready';let calls=0;
 const fetcher=async(url,options)=>{calls++;assert.ok(!options.headers.Authorization);assert.ok(!options.body);return replicaResponse(url)??new Response(url.includes('raw.githubusercontent.com')?JSON.stringify(publicFixture(url)):'<title>Market data</title><h1>Markets</h1>',{headers:{'content-type':url.includes('raw.githubusercontent.com')?'text/plain':'text/html'}});};
 const result=await remoteHealth({fetcher,now});assert.equal(result.healthy,true);assert.equal(calls,11);assert.equal(result.commodities.healthy,true);assert.equal(result.oil.healthy,true);
 const bad=await remoteHealth({now,sleep:async()=>{},fetcher:async url=>replicaResponse(url)??(url.includes('raw.githubusercontent.com')?new Response(JSON.stringify(publicFixture(url)),{headers:{'content-type':'text/plain'}}):new Response('<title>Not found</title>',{headers:{'content-type':'text/html'}}))});
 assert.equal(bad.healthy,false);assert.equal(bad.issues.length,6);
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
 const visited=[];const result=await remoteHealth({now,fetcher:async(url,options)=>{visited.push(url);assert.ok(!options.headers.Authorization);assert.ok(!options.body);return replicaResponse(url)??new Response(url===OIL_FEED_URL?'{}':url.includes('raw.githubusercontent.com')?JSON.stringify(publicFixture(url)):'<title>Markets</title><h1>Markets</h1>',{headers:{'content-type':url.includes('raw.githubusercontent.com')?'text/plain':'text/html'}});}});
 assert.equal(result.healthy,false);assert.equal(result.feed.healthy,true);assert.equal(result.oil,null);assert.equal(result.issues.length,1);assert.ok(result.issues[0].startsWith('Published EIA oil data:'));
 assert.ok(visited.includes('https://cascade-public.pages.dev/tools/gold-check/'));assert.ok(visited.includes('https://cascade-public.pages.dev/markets/oil/'));
});
test('commodity health reports contract, latest date, retention and separate check/report ages',()=>{
 const b=commodityFixture();const healthy=commodityFeedHealth(b,{now});assert.equal(healthy.healthy,true);assert.deepEqual(healthy.contracts,{gold:'088691',oil:'067651'});assert.deepEqual(healthy.observation_dates,{gold:'2026-10-06',oil:'2026-10-06'});
 b.instruments.gold.state='retained';const retained=commodityFeedHealth(b,{now});assert.equal(retained.issues.length,1);assert.match(retained.issues[0],/088691; report 2026-10-06.*retained/);
 const delayed=commodityFeedHealth(commodityFixture(),{now:now+DAY+1});assert.equal(delayed.issues.filter(issue=>issue.includes('24 hours')).length,2);assert.ok(!delayed.issues.some(issue=>issue.includes('12 days')));
 const later=Date.parse('2026-10-19T12:00:00Z'),stale=commodityFixture();stale.generated_at=new Date(later).toISOString();for(const series of Object.values(stale.instruments))series.checked_at=stale.generated_at;
 const result=commodityFeedHealth(stale,{now:later});assert.equal(result.issues.filter(issue=>issue.includes('12 days')).length,2);assert.ok(!result.issues.some(issue=>issue.includes('24 hours')));assert.match(result.issues.find(issue=>issue.includes('WTI')),/067651; report 2026-10-06/);
 const invalid=commodityFixture();invalid.instruments.gold.contract='067651';assert.throws(()=>commodityFeedHealth(invalid,{now}));
});
test('remote commodity validation and body-limit failures remain visible without disrupting other checks',async()=>{
 let calls=0;const fetcher=async url=>{calls++;return replicaResponse(url)??new Response(url===COMMODITY_FEED_URL?'{}':url.includes('raw.githubusercontent.com')?JSON.stringify(publicFixture(url)):'<title>Markets</title><h1>Markets</h1>',{headers:{'content-type':url.includes('raw.githubusercontent.com')?'text/plain':'text/html'}});};
 const result=await remoteHealth({now,fetcher});assert.equal(calls,11);assert.equal(result.healthy,false);assert.equal(result.commodities,null);assert.equal(result.feed.healthy,true);assert.equal(result.oil.healthy,true);assert.equal(result.issues.length,1);assert.ok(result.issues[0].startsWith('Published CFTC commodity data:'));
 const oversized=await remoteHealth({now,fetcher:async url=>replicaResponse(url)??(url===COMMODITY_FEED_URL?new Response('x'.repeat(300001),{headers:{'content-type':'text/plain'}}):url.includes('raw.githubusercontent.com')?new Response(JSON.stringify(publicFixture(url)),{headers:{'content-type':'text/plain'}}):new Response('<title>Markets</title><h1>Markets</h1>',{headers:{'content-type':'text/html'}}))});
 assert.equal(oversized.issues.length,1);assert.match(oversized.issues[0],/commodity data: source exceeds size limit/);
});

test('replica validates its exact raw bytes, publication marker and public CORS independently of primary health',async()=>{
 for(const mutate of [
  r=>{r.text+=' ';},
  r=>{r.marker.schema='unknown';},
  r=>{r.marker.slot++;},
  r=>{r.marker.published_at=new Date(now+1).toISOString();},
  r=>{r.marker.files.feed.path='/other.json';},
  r=>{r.marker.files.oil.sha256='short';},
  r=>{r.marker.files.commodities.generated_at='not-a-date';},
  r=>{delete r.marker.files.oil;},
  r=>{r.marker.files.feed.generated_at=new Date(now-1).toISOString();}
 ]){
  const replica=replicaFixture();mutate(replica);
  const result=await remoteHealth({now,fetcher:async(url,options)=>{
   assert.ok(!options.headers.Authorization);assert.ok(!options.body);
   if(url.startsWith(REPLICA_ORIGIN)){assert.equal(options.headers.Accept,'application/json');return replicaResponse(url,replica);}
   return new Response(url.includes('raw.githubusercontent.com')?JSON.stringify(publicFixture(url)):'<title>Markets</title><h1>Markets</h1>',{headers:{'content-type':url.includes('raw.githubusercontent.com')?'text/plain':'text/html'}});
  }});
  assert.equal(result.healthy,false);assert.equal(result.feed.healthy,true);assert.equal(result.replica.healthy,false);
  assert.ok(result.issues.every(issue=>issue.startsWith('Static replica:')));
 }
 const cors=await replicaHealth({now,fetcher:async url=>replicaResponse(url,replicaFixture(),{'access-control-allow-origin':'https://other.example'})});
 assert.equal(cors.healthy,false);assert.match(cors.issues.join(' '),/CORS/);
});
test('replica body limits and changed content types fail visibly without accepting a marker',async()=>{
 for(const [route,body,type] of [['/replica.json','x'.repeat(20001),'application/json'],['/data/feed.json','x'.repeat(2000001),'application/json'],['/replica.json','<h1>Not JSON</h1>','text/html']]){
  const result=await replicaHealth({now,sleep:async()=>{},fetcher:async url=>url.endsWith(route)?new Response(body,{headers:{'content-type':type,'access-control-allow-origin':'*'}}):replicaResponse(url)});
  assert.equal(result.healthy,false);
  assert.ok(result.issues.some(issue=>/size limit|content type/.test(issue)));
 }
});
test('replica publication age, contained feed age, source failure and primary lag remain separate failures',async()=>{
 const late=now+8*3600000+1;
 let result=await replicaHealth({now:late,fetcher:async url=>replicaResponse(url)});
 assert.ok(result.issues.some(issue=>issue.includes('publication is older than 8 hours')));
 assert.ok(result.issues.some(issue=>issue.startsWith('Collector checks')));
 const freshMarker=replicaFixture(fixture(),new Date(late).toISOString());
 result=await replicaHealth({now:late,fetcher:async url=>replicaResponse(url,freshMarker)});
 assert.ok(result.issues.some(issue=>issue.startsWith('Collector checks')));
 assert.ok(!result.issues.some(issue=>issue.includes('publication is older')));
 const failed=fixture();failed.outcomes.ecb.state='failed';
 result=await replicaHealth({now,fetcher:async url=>replicaResponse(url,replicaFixture(failed))});
 assert.ok(result.issues.some(issue=>issue.startsWith('ECB: source collection did not complete')));
 const primary=fixture(),later=now+7*3600000;primary.generated_at=new Date(later).toISOString();for(const outcome of Object.values(primary.outcomes))outcome.checked_at=primary.generated_at;
 const combined=await remoteHealth({now:later,fetcher:async url=>replicaResponse(url)??new Response(url.includes('raw.githubusercontent.com')?JSON.stringify(url.endsWith('/data/feed.json')?primary:publicFixture(url)):'<title>Markets</title><h1>Markets</h1>',{headers:{'content-type':url.includes('raw.githubusercontent.com')?'text/plain':'text/html'}})});
 assert.equal(combined.feed.healthy,true);assert.equal(combined.replica.feed.healthy,true);
 assert.equal(combined.replica.healthy,false);assert.match(combined.replica.issues.join(' '),/lags the primary by more than 6 hours/);
});
