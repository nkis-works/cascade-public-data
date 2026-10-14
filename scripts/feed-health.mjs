import {readFile, appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';
import {OIL_FEED_URL, OIL_SOURCES, validateOil, oilSeriesHealth} from '../src/oil-data.js';
import {validateFeed, FEED_INTERVAL} from '../src/feed-contract.js';
import {fetchSourceBytes, sourceFailureReason} from './source-fetch.mjs';

const FEED_URL='https://raw.githubusercontent.com/nkis-works/cascade-public-data/main/data/feed.json';
const SITE='https://cascade-public.pages.dev';
const DAY=86400000;
export function feedHealth(bundle,{now=Date.now()}={}) {
 validateFeed(bundle,{now});
 const issues=[];
 if(now-Date.parse(bundle.generated_at)>4*FEED_INTERVAL)issues.push('Collector checks have not completed for more than 24 hours');
 // CFTC reports describe Tuesday positions but normally publish on Friday.
 // Twelve days allows the following Friday release and the next collection cycle.
 const sources={ecb:{name:'ECB',date:bundle.observatory.sources.ecb.reference_date,days:5,collected:bundle.observatory.sources.ecb.collected_at},cftc_fx:{name:'CFTC currency futures',date:bundle.weekly.instruments.USDJPY.at(-1).date,days:12,collected:bundle.weekly.collected_at},gold:{name:'CFTC gold futures',date:bundle.observatory.sources.cftc.report_date,days:12,collected:bundle.observatory.sources.cftc.collected_at}};
 for(const [key,source] of Object.entries(sources)){
  if(bundle.outcomes[key].state!=='ready')issues.push(source.name+': source collection did not complete');
  if(!source.date||now-Date.parse(source.date+'T00:00:00Z')>source.days*DAY)issues.push(source.name+': observation date is missing or too old');
  if(!source.collected||now-Date.parse(source.collected)>4*FEED_INTERVAL)issues.push(source.name+': no successful source check for more than 24 hours');
 }
 return {healthy:issues.length===0,issues,generated_at:bundle.generated_at,observation_dates:{ecb:sources.ecb.date,cftc_fx:sources.cftc_fx.date,gold:sources.gold.date}};
}

export function oilHealth(bundle,{now=Date.now()}={}){
 validateOil(bundle,{now});
 const issues=[],observation_dates={};
 if(now-Date.parse(bundle.generated_at)>DAY)issues.push('EIA collector checks have not completed for more than 24 hours');
 for(const [key,series] of Object.entries(bundle.series)){
  const health=oilSeriesHealth(series,{now}),name='EIA '+OIL_SOURCES[key].title;
  observation_dates[key]=series.rows.at(-1).date;
  if(health.retained)issues.push(name+': source collection did not complete; previous observations retained');
  if(health.delayed)issues.push(name+': source check is delayed for more than 24 hours');
  if(health.stale)issues.push(name+': observation or scheduled release is too old');
 }
 return {healthy:issues.length===0,issues,generated_at:bundle.generated_at,observation_dates};
}

export async function remoteHealth({fetcher=fetch,sleep,now=Date.now()}={}){
 const issues=[];let feed=null,oil=null;
 const checks=[['Published data feed',FEED_URL,'text/plain',2000000],['Published EIA oil data',OIL_FEED_URL,'text/plain',150000],...['/','/tools/position-check/','/tools/position-map/','/tools/gold-check/','/markets/oil/'].map(route=>[route,SITE+route,'text/html',300000])];
 await Promise.all(checks.map(async([name,url,accept,maxBytes])=>{
  try{
   const {buffer}=await fetchSourceBytes(url,{accept,maxBytes,fetcher,sleep,timeoutMs:12000});
   const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
   if(url===FEED_URL){feed=feedHealth(JSON.parse(text),{now});issues.push(...feed.issues);}
   else if(url===OIL_FEED_URL){oil=oilHealth(JSON.parse(text),{now});issues.push(...oil.issues);}
   else if(!/<h1\b/i.test(text)||!/<title>[^<]+<\/title>/i.test(text))issues.push(name+': expected page content is missing');
  }catch(error){issues.push(name+': '+sourceFailureReason(error));}
 }));
 return {healthy:issues.length===0,issues,feed,oil,checked_at:new Date(now).toISOString()};
}

async function main(){
 const remote=process.argv[2]==='--remote';
 let result;
 if(remote)result=await remoteHealth();
 else{
  const file=process.argv[2]??'data/feed.json',feed=feedHealth(JSON.parse(await readFile(file,'utf8')));
  let oil;try{oil=oilHealth(JSON.parse(await readFile(process.argv[3]??join(dirname(file),'oil.json'),'utf8')));}
  catch(error){oil={healthy:false,issues:['EIA oil data: '+sourceFailureReason(error)]};}
  const issues=[...feed.issues,...oil.issues];result={healthy:issues.length===0,issues,feed,oil};
 }
 console.log(JSON.stringify(result));
 if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'### Public market data health\n\n'+(result.healthy?'All monitored sources and checks passed.':result.issues.map(issue=>'- '+issue).join('\n'))+'\n');
 if(!result.healthy){for(const issue of result.issues)console.error('::error::'+issue.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error('::error::Feed health check could not complete: '+sourceFailureReason(error));process.exitCode=1;});
