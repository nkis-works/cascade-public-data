// CFTC report-date positions in contracts. Spreading is separate from direction.
export const COMMODITY_FEED_URL = 'https://raw.githubusercontent.com/nkis-works/cascade-public-data/main/data/commodities.json';
export const COMMODITY_CONTRACTS = Object.freeze({gold:'088691', oil:'067651'});
export const COMMODITY_GROUPS = Object.freeze(['producer','swap','managed','other']);
const DAY = 86400000;
function fail() { throw new Error('Invalid commodity positions'); }
function instant(value, now) {
 if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value)>now) fail();
 if(new Date(value).toISOString()!==value.replace(/Z$/, value.includes('.')?'Z':'.000Z')) fail();
 return Date.parse(value);
}
function reportDate(value, now) {
 if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0,10)!==value || Date.parse(value)>now) fail();
}
export function validateCommoditySeries(series, {now=Date.now(), contract}={}) {
 now=Number(new Date(now));
 if(!series || !['ready','retained'].includes(series.state) || series.contract!==contract) fail();
 const checked=instant(series.checked_at,now), collected=instant(series.collected_at,now);
 if(collected>checked) fail();
 let url; try { url=new URL(series.source_url); } catch { fail(); }
 if(url.origin!=='https://publicreporting.cftc.gov' || url.pathname!=='/resource/72hh-3qpy.json' || url.username || url.password || url.hash) fail();
 if(!Array.isArray(series.rows) || series.rows.length!==156) fail();
 let last='';
 for(const row of series.rows) {
  reportDate(row.date, Math.min(now,collected));
  if(row.date<=last || !Number.isSafeInteger(row.open_interest) || row.open_interest<=0) fail();
  last=row.date;
  if(!row.groups || Object.keys(row.groups).length!==4) fail();
  let totalLong=0,totalShort=0;
  for(const group of COMMODITY_GROUPS) {
   const values=row.groups[group];
   if(!values || Object.keys(values).length!==3) fail();
   for(const key of ['long','short','spread']) if(!Number.isSafeInteger(values[key]) || values[key]<0 || values[key]>row.open_interest) fail();
   if(group==='producer' && values.spread!==0) fail();
   if(values.long+values.spread>row.open_interest || values.short+values.spread>row.open_interest) fail();
   totalLong+=values.long+values.spread;totalShort+=values.short+values.spread;
  }
  if(totalLong>row.open_interest || totalShort>row.open_interest) fail();
 }
 return series;
}
export function validateCommodityPositions(bundle,{now=Date.now(),previous}={}) {
 now=Number(new Date(now));
 if(!Number.isFinite(now) || bundle?.schema!=='PUBLIC_COMMODITIES_1') fail();
 const generated=instant(bundle.generated_at,now);
 if(!bundle.instruments || Object.keys(bundle.instruments).length!==2) fail();
 for(const [asset,contract] of Object.entries(COMMODITY_CONTRACTS)) {
  const series=validateCommoditySeries(bundle.instruments[asset],{now,contract});
  if(Date.parse(series.checked_at)>generated) fail();
  const prior=previous?.instruments?.[asset];
  if(prior && (series.rows.at(-1).date<prior.rows.at(-1).date || Date.parse(series.collected_at)<Date.parse(prior.collected_at) || Date.parse(series.checked_at)<Date.parse(prior.checked_at))) fail();
 }
 return bundle;
}
export function commodityWarnings(bundle,{now=Date.now()}={}) {
 const warnings=[]; now=Number(new Date(now));
 for(const [asset,series] of Object.entries(bundle.instruments)) {
  if(now-Date.parse(series.rows.at(-1).date)>12*DAY) warnings.push({asset,code:'stale-report',date:series.rows.at(-1).date});
  if(now-Date.parse(series.checked_at)>DAY) warnings.push({asset,code:'stale-check',date:series.checked_at});
  if(series.state==='retained') warnings.push({asset,code:'retained'});
 }
 return warnings;
}
async function boundedJSON(response,allowPlainText=false) {
 const type=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
 if(type!=='application/json' && !(allowPlainText && type==='text/plain')) {await response.body?.cancel();throw new Error('Commodity feed content type unavailable');}
 if(!response.ok || Number(response.headers.get('content-length')||0)>300000) throw new Error('Commodity feed unavailable');
 const reader=response.body?.getReader(); if(!reader) throw new Error('Commodity feed unavailable');
 const chunks=[]; let size=0;
 try { for(;;) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength; if(size>300000){await reader.cancel();throw new Error('Commodity feed too large');} chunks.push(value); } } finally {reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export async function loadCommodityPositions(fetcher=fetch,{now=Date.now(),previous}={}) {
 for(const [url,mode] of [[COMMODITY_FEED_URL,'automatic'],['/data/commodities.json','fallback']]) {
  try {
   const response=await fetcher(url,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:AbortSignal.timeout(15000)});
   const bundle=validateCommodityPositions(await boundedJSON(response,url===COMMODITY_FEED_URL),{now,previous});
   return {bundle,mode,warnings:commodityWarnings(bundle,{now})};
  } catch { /* A validated local snapshot remains available when the public feed fails. */ }
 }
 if(previous) {validateCommodityPositions(previous,{now});const bundle={...previous,instruments:Object.fromEntries(Object.entries(previous.instruments).map(([asset,series])=>[asset,{...series,state:'retained'}]))};return {bundle,mode:'retained',warnings:commodityWarnings(bundle,{now})};}
 throw new Error('Commodity positions unavailable');
}
export function commodityReading(series,{date,group='managed',window=156}={}) {
 if(!COMMODITY_GROUPS.includes(group) || !Number.isSafeInteger(window) || window<1 || window>156) fail();
 const rows=series.rows, latest=rows.at(-1);
 const selected=date ? rows.find(row=>row.date===date) : latest;
 if(!selected) fail();
 const index=rows.indexOf(selected), previous=rows[index-1]||null;
 const historyPrefix=rows.slice(Math.max(0,index-window+1),index+1);
 const earlier=historyPrefix.slice(0,-1);
 const positions=selected.groups[group], net=positions.long-positions.short;
 const ratio=net/selected.open_interest;
 const rank=values=>{
  if(values.length<52)return null;
  const tolerance=1e-12;
  let less=0,equal=0;
  for(const value of values){if(Math.abs(value-ratio)<=tolerance)equal++;else if(value<ratio)less++;}
  return 100*(less+0.5*equal)/values.length;
 };
 const gaps=[];const prefix=historyPrefix;
 for(let i=1;i<prefix.length;i++)if(Date.parse(prefix[i].date)-Date.parse(prefix[i-1].date)>7*DAY)gaps.push({from:prefix[i-1].date,to:prefix[i].date,days:(Date.parse(prefix[i].date)-Date.parse(prefix[i-1].date))/DAY});
 return {date:selected.date,selectedDate:selected.date,latestDate:latest.date,previousDate:previous?.date||null,group,long:positions.long,short:positions.short,spread:positions.spread,net,openInterest:selected.open_interest,netOpenInterest:ratio,netOi:ratio,deltaSpread:previous?positions.spread-previous.groups[group].spread:null,gapDays:previous?(Date.parse(selected.date)-Date.parse(previous.date))/DAY:null,deltaLong:previous?positions.long-previous.groups[group].long:null,deltaShort:previous?positions.short-previous.groups[group].short:null,deltaNet:previous?net-(previous.groups[group].long-previous.groups[group].short):null,rank:rank(earlier.map(row=>(row.groups[group].long-row.groups[group].short)/row.open_interest)),sampleCount:earlier.length,historyPrefix,gaps};
}

export function commodityHealth(series,{now=Date.now()}={}) {
 const stamp=Number(new Date(now));
 const delayed=stamp-Date.parse(series.checked_at)>DAY;
 const stale=stamp-Date.parse(series.rows.at(-1).date)>12*DAY;
 const retained=series.state==='retained';
 return {warning:delayed||stale||retained,delayed,stale,retained};
}
