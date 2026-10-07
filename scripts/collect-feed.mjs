import {readFile,writeFile,rename,rm,mkdir} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {parseEcbCsv,parseCftc} from '../worker/sources.js';
import {referenceSeries,frameFromSeries,FORMULA_VERSION} from '../src/reference-math.js';
import {buildPositioning} from './build-positioning.mjs';
import {FEED_SCHEMA,FEED_INTERVAL,ECB_FEED_SOURCE,validateFeed} from '../src/feed-contract.js';
async function readSource(url,type,max,fetcher){
 const response=await fetcher(url,{headers:{Accept:type},redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok||Number(response.headers.get('content-length')||0)>max)throw Error('Source unavailable');
 const text=await response.text();if(Buffer.byteLength(text)>max)throw Error('Source too large');return text;
}
export async function collectFeed({file=fileURLToPath(new URL('../data/public-feed.json',import.meta.url)),fetcher=fetch,buildWeekly=buildPositioning}={}){
 let previous=null;try{previous=validateFeed(JSON.parse(await readFile(file,'utf8')));}catch(error){if(error.code!=='ENOENT')throw error;}
 const attempts=await Promise.allSettled([
  (async()=>{const inputs=parseEcbCsv(await readSource(ECB_FEED_SOURCE,'text/csv',2000000,fetcher));const collected_at=new Date().toISOString();const rows=['EURUSD','GBPUSD','USDJPY'].map(instrument=>{const history=referenceSeries(inputs[instrument]);return {...frameFromSeries(instrument,history,ECB_FEED_SOURCE),collected_at,history};});return {inputs,rows,collected_at};})(),
  buildWeekly().then(result=>result.dataset),
  (async()=>{const url=new URL('https://publicreporting.cftc.gov/resource/72hh-3qpy.json');url.search=new URLSearchParams({'$select':'id,report_date_as_yyyy_mm_dd,cftc_contract_market_code,market_and_exchange_names,open_interest_all,m_money_positions_long_all,m_money_positions_short_all,futonly_or_combined','$where':"cftc_contract_market_code = '088691'",'$order':'report_date_as_yyyy_mm_dd DESC','$limit':'1'});const rows=JSON.parse(await readSource(url,'application/json',20000,fetcher));if(!Array.isArray(rows)||rows.length!==1||rows[0].futonly_or_combined!=='FutOnly')throw Error('Gold report mismatch');return {gold:{...parseCftc('XAUUSD',rows[0]),source_url:url.href},collected_at:new Date().toISOString()};})()
 ]);
 if(!previous&&attempts.slice(0,2).some(result=>result.status!=='fulfilled'))throw Error('Initial daily and weekly collection must both succeed');
 const checked=new Date().toISOString(),outcomes={};
 for(const [i,key]of ['ecb','cftc_fx','gold'].entries())outcomes[key]={state:attempts[i].status==='fulfilled'?'ready':previous?'failed':'unavailable',checked_at:checked};
 const daily=attempts[0].status==='fulfilled'?attempts[0].value:{inputs:previous.reference_inputs,rows:previous.observatory.rows,collected_at:previous.observatory.sources.ecb.collected_at};
 const weekly=attempts[1].status==='fulfilled'?attempts[1].value:previous.weekly;
 const gold=attempts[2].status==='fulfilled'?attempts[2].value:previous?.observatory.sources.cftc.status==='available'?{gold:previous.observatory.cftc.XAUUSD,collected_at:previous.observatory.sources.cftc.collected_at}:null;
 const observatory={schema:'CASCADE_OBSERVATORY_1',formula_version:FORMULA_VERSION,generated_at:daily.collected_at,rows:daily.rows,cftc:gold?{XAUUSD:gold.gold}:{},sources:{ecb:{status:'available',reference_date:daily.rows[0].reference_date,collected_at:daily.collected_at},cftc:gold?{status:'available',report_date:gold.gold.report_date,collected_at:gold.collected_at}:{status:'unavailable'}}};
 const bundle=validateFeed({schema:FEED_SCHEMA,generated_at:checked,interval_ms:FEED_INTERVAL,outcomes,reference_inputs:daily.inputs,observatory,weekly},{previous});
 await mkdir(path.dirname(file),{recursive:true});const temp=file+'.tmp';
 try{await writeFile(temp,JSON.stringify(bundle,null,2)+'\n');await rename(temp,file);}finally{await rm(temp,{force:true});}
 return {schema:bundle.schema,outcomes,reference_date:observatory.sources.ecb.reference_date,report_date:weekly.instruments.USDJPY.at(-1).date,gold_date:gold?.gold.report_date??null};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await collectFeed()));
