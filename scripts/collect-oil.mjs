import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {dirname} from 'node:path';import {pathToFileURL} from 'node:url';
import {fetchSourceBytes,sourceFailureReason} from './source-fetch.mjs';
import {OIL_SOURCES,validateOil,validateOilSeries,oilDate} from '../src/oil-data.js';
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const text=value=>value.replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').trim();
const iso=(year,month,day)=>`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
const missing=value=>value===''||['-','--','NA','W'].includes(value);
function observation(value){if(!/^-?\d+(?:,\d{3})*(?:\.\d+)?$/.test(value))throw Error('Unexpected EIA number');const number=Number(value.replaceAll(',',''));if(!Number.isFinite(number))throw Error('Invalid EIA number');return number;}
export function parseOilHtml(html,key){
 const source=OIL_SOURCES[key];if(!source||typeof html!=='string'||!html.includes(source.title)||!html.includes(key==='inventory'?'Thousand Barrels':'Dollars per Barrel'))throw Error('EIA series identity changed');
 const dateFrom=label=>{const m=html.match(new RegExp('>\\s*'+label+':\\s*(\\d{1,2})/(\\d{1,2})/(\\d{4})'));if(!m)throw Error('EIA release date missing');const d=iso(m[3],m[1],m[2]);if(!oilDate(d))throw Error('Invalid EIA release date');return d;};
 const release_date=dateFrom('Release Date'),next_release_date=dateFrom('Next Release Date'),rows=[];
 for(const [row] of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)){
  const cells=[...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>text(m[1]));
  const header=cells[0]??'';
  if(key==='inventory'){
   const m=header.match(/^(\d{4})-([A-Z][a-z]{2})$/);if(!m)continue;
   if(cells.length!==11)throw Error('EIA weekly columns changed');
   for(let i=1;i<cells.length;i+=2){if(missing(cells[i+1]))continue;const date=cells[i].match(/^(\d{2})\/(\d{2})$/);if(!date||Number(date[1])!==MONTHS.indexOf(m[2])+1)throw Error('EIA weekly date changed');rows.push({date:iso(m[1],date[1],date[2]),value:observation(cells[i+1])});}
  }else{
   const m=header.match(/^(\d{4}) ([A-Z][a-z]{2})-\s*(\d{1,2}) to ([A-Z][a-z]{2})-\s*(\d{1,2})$/);if(!m)continue;
   if(cells.length!==6)throw Error('EIA daily columns changed');
   const monday=iso(m[1],MONTHS.indexOf(m[2])+1,m[3]);if(!oilDate(monday)||new Date(monday).getUTCDay()!==1)throw Error('EIA weekly start changed');
   const friday=new Date(Date.parse(monday)+4*86400000);
   if(friday.getUTCMonth()!==MONTHS.indexOf(m[4])||friday.getUTCDate()!==Number(m[5]))throw Error('EIA week end changed');
   for(let i=1;i<=5;i++)if(!missing(cells[i]))rows.push({date:new Date(Date.parse(monday)+(i-1)*86400000).toISOString().slice(0,10),value:observation(cells[i])});
  }
 }
 if(rows.length<60)throw Error('EIA history unexpectedly short');
 return {release_date,next_release_date,rows:rows.slice(-260)};
}
export async function collectOil({file='data/oil.json',fetcher=fetch,now=Date.now(),sleep}={}){
 let previous=null;try{previous=validateOil(JSON.parse(await readFile(file,'utf8')),{now});}catch{}
 const stamp=new Date(now).toISOString(),series={};
 await Promise.all(Object.entries(OIL_SOURCES).map(async([key,s])=>{
  try{
   const {buffer}=await fetchSourceBytes(s.url,{accept:'text/html',maxBytes:1000000,fetcher,sleep});
   const parsed=parseOilHtml(new TextDecoder('utf-8',{fatal:true}).decode(buffer),key);
   if(previous?.series[key].rows.at(-1).date>parsed.rows.at(-1).date)throw Error('EIA report regressed');
   series[key]=validateOilSeries(key,{state:'ready',checked_at:stamp,collected_at:stamp,source_url:s.url,unit:s.unit,...parsed},{now});
  }catch(error){if(!previous)throw Error(key+': '+sourceFailureReason(error));series[key]={...previous.series[key],state:'retained',checked_at:stamp};console.error(JSON.stringify({source:'eia_'+key,state:'retained',reason:sourceFailureReason(error)}));}
 }));
 const bundle=validateOil({schema:'PUBLIC_OIL_1',generated_at:stamp,series},{now,previous});
 await mkdir(dirname(file),{recursive:true});const tmp=file+'.tmp';await writeFile(tmp,JSON.stringify(bundle)+'\n');await rename(tmp,file);
 return {schema:bundle.schema,generated_at:stamp,sources:Object.fromEntries(Object.entries(series).map(([key,s])=>[key,{state:s.state,date:s.rows.at(-1).date,release_date:s.release_date,next_release_date:s.next_release_date}]))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)collectOil({file:process.argv[2]??'data/oil.json'}).then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error('Oil collection failed: '+sourceFailureReason(e));process.exitCode=1;});
