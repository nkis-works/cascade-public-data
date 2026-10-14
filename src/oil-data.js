export const OIL_FEED_URL='https://raw.githubusercontent.com/nkis-works/cascade-public-data/main/data/oil.json';
export const OIL_SOURCES={
 wti:{url:'https://www.eia.gov/dnav/pet/hist/RWTCD.htm',title:'Cushing, OK WTI Spot Price FOB',unit:'USD/barrel'},
 brent:{url:'https://www.eia.gov/dnav/pet/hist/RBRTED.htm',title:'Europe Brent Spot Price FOB',unit:'USD/barrel'},
 inventory:{url:'https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=WCESTUS1&f=W',title:'Weekly U.S. Ending Stocks excluding SPR of Crude Oil',unit:'thousand_barrels'}
};
const DAY=86400000;
export function oilDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
export function validateOilSeries(key,s,{now=Date.now()}={}){
 const definition=OIL_SOURCES[key],stamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now+300000;
 if(!definition||!s||!['ready','retained'].includes(s.state)||!stamp(s.checked_at)||s.source_url!==definition.url||s.unit!==definition.unit)throw Error('Invalid oil source');
 if(!Array.isArray(s.rows)||s.rows.length>260||s.rows.length<2)throw Error('Oil history missing');
 if(!stamp(s.collected_at)||Date.parse(s.collected_at)>Date.parse(s.checked_at)||!oilDate(s.release_date)||!oilDate(s.next_release_date)||Date.parse(s.release_date)>now||!oilDate(s.rows.at(-1)?.date)||Date.parse(s.release_date)-Date.parse(s.rows.at(-1).date)>21*DAY||Date.parse(s.next_release_date)<=Date.parse(s.release_date)||Date.parse(s.next_release_date)-Date.parse(s.release_date)>21*DAY)throw Error('Invalid oil release dates');
 let last='';for(const r of s.rows){if(!oilDate(r.date)||r.date<=last||r.date<'1980-01-01'||Date.parse(r.date)>Date.parse(s.release_date)||!Number.isFinite(r.value)||Math.abs(r.value)> (key==='inventory'?100000000:100000)||key==='inventory'&&(!Number.isSafeInteger(r.value)||r.value<=0))throw Error('Invalid oil observation');last=r.date;}
 return s;
}
export function validateOil(bundle,{now=Date.now(),previous=null}={}){
 const stamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now+300000;
 if(bundle?.schema!=='PUBLIC_OIL_1'||!stamp(bundle.generated_at)||!bundle.series||Object.keys(bundle.series).sort().join(',')!=='brent,inventory,wti')throw Error('Invalid oil snapshot');
 for(const key of Object.keys(OIL_SOURCES)){
  const s=validateOilSeries(key,bundle.series[key],{now});
  if(previous?.series?.[key]?.rows?.at(-1)?.date>s.rows.at(-1).date)throw Error('Oil observation regression');
 }
 return bundle;
}
export function oilSeriesHealth(series,{now=Date.now()}={}){
 const delayed=now-Date.parse(series.checked_at)>DAY;
 const stale=now>Date.parse(series.next_release_date+'T23:59:59Z')+2*DAY||now-Date.parse(series.rows.at(-1).date)>21*DAY;
 return {warning:series.state!=='ready'||delayed||stale,delayed,stale,retained:series.state!=='ready'};
}
export function oilChange(series,offset=1){
 const latest=series.rows.at(-1),prior=series.rows.at(-1-offset);if(!latest||!prior)return null;
 // Price differences remain valid when the original WTI observation was zero or negative.
 return {date:latest.date,previous:prior.date,latest:latest.value,change:latest.value-prior.value,gapDays:(Date.parse(latest.date)-Date.parse(prior.date))/DAY};
}
export function oilSpread(bundle){
 const wti=new Map(bundle.series.wti.rows.map(r=>[r.date,r.value]));
 const b=bundle.series.brent.rows.findLast(r=>wti.has(r.date));
 return b?{date:b.date,value:b.value-wti.get(b.date)}:null;
}
export async function loadOil(fetcher=fetch,{now=Date.now()}={}){
 async function read(url,raw){
  const r=await fetcher(url,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:AbortSignal.timeout(12000)});
  const type=r.headers.get('content-type')?.split(';')[0];if(!r.ok||![raw?'text/plain':'application/json','application/json'].includes(type))throw Error('Oil snapshot unavailable');
  const reader=r.body?.getReader();if(!reader)throw Error('Missing oil body');let size=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>150000)throw Error('Oil snapshot too large');chunks.push(value);}}
  catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}
  return validateOil(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),{now});
 }
 try{return {bundle:await read(OIL_FEED_URL,true),mode:'automatic'};}
 catch{return {bundle:await read('/data/oil.json',false),mode:'fallback'};}
}
