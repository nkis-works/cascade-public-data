import {validPositioningDataset,POSITIONING_PAIRS} from './positioning.js';
import {referenceSeries,frameFromSeries,FORMULA_VERSION} from './reference-math.js';
export const FEED_SCHEMA='CASCADE_PUBLIC_FEED_1';
export const FEED_INTERVAL=6*60*60*1000;
export const ECB_FEED_SOURCE='https://data-api.ecb.europa.eu/service/data/EXR/D.USD+GBP+JPY.EUR.SP00.A?lastNObservations=320&format=csvdata&detail=dataonly';
const fail=message=>{throw Error(message);};
const timestamp=(value,now)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value&&Date.parse(value)<=now+300000;
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...expected].sort());
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const date=(value,now)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value&&Date.parse(value+'T00:00:00Z')<=now;
export function validateFeed(bundle,{now=Date.now(),previous=null}={}){
 if(!Number.isFinite(now)||!keys(bundle,['schema','generated_at','interval_ms','outcomes','reference_inputs','observatory','weekly'])||bundle.schema!==FEED_SCHEMA||bundle.interval_ms!==FEED_INTERVAL||!timestamp(bundle.generated_at,now))fail('Unsupported public feed');
 if(!keys(bundle.outcomes,['ecb','cftc_fx','gold']))fail('Missing source outcomes');
 for(const outcome of Object.values(bundle.outcomes)){
  if(!keys(outcome,['state','checked_at'])||!['ready','failed','unavailable'].includes(outcome.state)||!timestamp(outcome.checked_at,now)||outcome.checked_at!==bundle.generated_at)fail('Invalid source outcome');
 }
 const api=bundle.observatory;
 if(!api||api.schema!=='CASCADE_OBSERVATORY_1'||api.formula_version!==FORMULA_VERSION||!Array.isArray(api.rows)||api.rows.length!==3||!timestamp(api.generated_at,now)||!keys(api.sources,['ecb','cftc'])||!keys(bundle.reference_inputs,POSITIONING_PAIRS))fail('Invalid reference snapshot');
 const expectedDates=new Set(),seen=new Set();
 for(const row of api.rows){
  if(!POSITIONING_PAIRS.includes(row?.instrument)||seen.has(row.instrument))fail('Incomplete instruments');seen.add(row.instrument);
  const input=bundle.reference_inputs[row.instrument];
  if(!Array.isArray(input)||input.length<81||input.length>320||input.some(p=>!Array.isArray(p)||p.length!==2||!date(p[0],now)||!Number.isFinite(p[1])||p[1]<=0))fail('Invalid reference inputs');
  const history=referenceSeries(input),frame=frameFromSeries(row.instrument,history,ECB_FEED_SOURCE);
  if(!equal(row.history,history))fail('Reference calculation mismatch');
  for(const [key,value]of Object.entries(frame))if(!equal(row[key],value))fail('Reference frame mismatch: '+key);
  if(!timestamp(row.collected_at,now)||!date(row.reference_date,now)||row.collected_at!==api.sources.ecb.collected_at||row.reference_date!==api.sources.ecb.reference_date)fail('Inconsistent reference metadata');
  expectedDates.add(JSON.stringify(input.map(p=>p[0])));
 }
 if(expectedDates.size!==1||api.sources.ecb.status!=='available'||!timestamp(api.sources.ecb.collected_at,now)||api.generated_at!==api.sources.ecb.collected_at)fail('Unsynchronized reference history');
 if(!validPositioningDataset(bundle.weekly)||!timestamp(bundle.weekly.collected_at,now)||Object.keys(bundle.weekly.instruments).length!==3||Object.values(bundle.weekly.instruments).some(rows=>rows.length<53||!date(rows.at(-1).date,now)))fail('Invalid weekly snapshot');
 if(!api.cftc||!keys(api.cftc,api.sources.cftc.status==='available'?['XAUUSD']:[]))fail('Unexpected futures data');
 if(api.sources.cftc.status==='available'){
  const gold=api.cftc.XAUUSD,source=api.sources.cftc;
  if(!timestamp(source.collected_at,now)||!date(gold?.report_date,now)||gold.report_date!==source.report_date||gold.instrument!=='XAUUSD'||gold.schema!=='CASCADE_CFTC_CONTEXT_1'||gold.source_dataset_id!=='CFTC_DISAGG_FUTURES_ONLY_WEEKLY'||gold.report_type!=='FutOnly'||gold.trading_signal!=='DISABLED'||gold.source_record_id!==gold.report_date.slice(2).replaceAll('-','')+'088691F')fail('Invalid gold metadata');
  if(!Number.isSafeInteger(gold.open_interest)||gold.open_interest<=0||![gold.spec_long,gold.spec_short].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=gold.open_interest)||gold.spec_net!==gold.spec_long-gold.spec_short||gold.net_oi!==Number((gold.spec_net/gold.open_interest).toFixed(6))||gold.cot_bias!==Number(Math.tanh(gold.spec_net/gold.open_interest/.18).toFixed(6)))fail('Invalid gold calculation');
  const url=new URL(gold.source_url);if(url.origin!=='https://publicreporting.cftc.gov'||url.pathname!=='/resource/72hh-3qpy.json'||url.username||url.password)fail('Invalid gold source');
 }else if(api.sources.cftc.status!=='unavailable')fail('Invalid gold status');
 if(bundle.outcomes.ecb.state==='unavailable'||bundle.outcomes.cftc_fx.state==='unavailable'||bundle.outcomes.gold.state==='ready'&&api.sources.cftc.status!=='available')fail('Outcome contradicts source');
 if(previous){
  if(Date.parse(bundle.generated_at)<Date.parse(previous.generated_at)||api.sources.ecb.reference_date<previous.observatory.sources.ecb.reference_date||POSITIONING_PAIRS.some(p=>bundle.weekly.instruments[p].at(-1).date<previous.weekly.instruments[p].at(-1).date)||previous.observatory.sources.cftc.status==='available'&&(api.sources.cftc.status!=='available'||api.sources.cftc.report_date<previous.observatory.sources.cftc.report_date))fail('Backwards public snapshot');
 }
 return bundle;
}
