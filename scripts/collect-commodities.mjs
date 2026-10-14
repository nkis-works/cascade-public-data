import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {fetchSourceBytes,sourceFailureReason} from './source-fetch.mjs';
import {COMMODITY_CONTRACTS,validateCommoditySeries,validateCommodityPositions} from '../src/commodity-positioning.js';
export const CFTC_FIELDS = Object.freeze({producer:['prod_merc_positions_long','prod_merc_positions_short',null],swap:['swap_positions_long_all','swap__positions_short_all','swap__positions_spread_all'],managed:['m_money_positions_long_all','m_money_positions_short_all','m_money_positions_spread'],other:['other_rept_positions_long','other_rept_positions_short','other_rept_positions_spread']});
function invalid(){throw new Error('Invalid CFTC commodity data');}
function count(value){if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))invalid();return Number(value);}
export function normalizeCFTC(rows,contract,{now=Date.now()}={}) {
 if(!Array.isArray(rows)||rows.length!==156)invalid();
 const normalized=rows.map(row=>{
  if(row.cftc_contract_market_code!==contract||row.futonly_or_combined!=='FutOnly'||typeof row.report_date_as_yyyy_mm_dd!=='string'||!/^\d{4}-\d{2}-\d{2}T00:00:00\.000$/.test(row.report_date_as_yyyy_mm_dd))invalid();
  const date=row.report_date_as_yyyy_mm_dd.slice(0,10);
  if(row.id!==date.replaceAll('-','').slice(2)+contract+'F')invalid();
  return {date,open_interest:count(row.open_interest_all),groups:Object.fromEntries(Object.entries(CFTC_FIELDS).map(([group,fields])=>[group,Object.fromEntries(['long','short','spread'].map((key,i)=>[key,fields[i]===null?0:count(row[fields[i]])]))]))};
 }).sort((a,b)=>a.date.localeCompare(b.date));
 const stamp=new Date(now).toISOString();
 validateCommoditySeries({state:'ready',contract,checked_at:stamp,collected_at:stamp,source_url:'https://publicreporting.cftc.gov/resource/72hh-3qpy.json',rows:normalized},{now,contract});
 return normalized;
}
export function commoditySourceURL(contract,offset=0){
 const url=new URL('https://publicreporting.cftc.gov/resource/72hh-3qpy.json');
 url.searchParams.set('$select',['id','report_date_as_yyyy_mm_dd','cftc_contract_market_code','futonly_or_combined','open_interest_all',...Object.values(CFTC_FIELDS).flat().filter(Boolean)].join(','));
 url.searchParams.set('$where',`cftc_contract_market_code='${contract}' AND futonly_or_combined='FutOnly'`);
 url.searchParams.set('$order','report_date_as_yyyy_mm_dd DESC,id ASC');url.searchParams.set('$limit','100');url.searchParams.set('$offset',String(offset));return url.href;
}
export async function collectCommodities({previous,now=Date.now(),fetcher=fetch,sleep,log=()=>{}}={}){
 const stamp=new Date(now).toISOString(),instruments={};
 for(const [asset,contract] of Object.entries(COMMODITY_CONTRACTS)){
  try {
   const raw=[];
   for(let page=0;page<2 && raw.length<156;page++) {
    const {buffer}=await fetchSourceBytes(commoditySourceURL(contract,page*100),{accept:'application/json',maxBytes:200000,fetcher,sleep});
    const rows=JSON.parse(buffer.toString('utf8'));if(!Array.isArray(rows)||rows.length>100 || (page===0?rows.length!==100:rows.length<56))invalid();raw.push(...rows);
   }
   for(let i=1;i<raw.length;i++)if(typeof raw[i].report_date_as_yyyy_mm_dd!=='string' || raw[i].report_date_as_yyyy_mm_dd>=raw[i-1].report_date_as_yyyy_mm_dd)invalid();
   const rows=normalizeCFTC(raw.slice(0,156),contract,{now});
   const series={state:'ready',checked_at:stamp,collected_at:stamp,source_url:commoditySourceURL(contract),contract,rows};
   if(previous?.instruments?.[asset] && rows.at(-1).date<previous.instruments[asset].rows.at(-1).date)invalid();
   instruments[asset]=series;
  } catch(error){
   log(`${asset}: ${sourceFailureReason(error)}`);
   const prior=previous?.instruments?.[asset];if(!prior)throw new Error(`Commodity history unavailable: ${asset}`);
   validateCommoditySeries(prior,{now,contract});instruments[asset]={...prior,state:'retained',checked_at:stamp};
  }
 }
 return validateCommodityPositions({schema:'PUBLIC_COMMODITIES_1',generated_at:stamp,instruments},{now,previous});
}
export async function writeCommoditySnapshot(path,bundle){
 const temporary=`${path}.${process.pid}.tmp`;
 try{await writeFile(temporary,JSON.stringify(bundle)+'\n',{flag:'wx'});await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const path=fileURLToPath(new URL('../data/commodities.json',import.meta.url));let previous;
 try{previous=JSON.parse(await readFile(path,'utf8'));validateCommodityPositions(previous);}catch(error){if(error.code!=='ENOENT')throw error;}
 const bundle=await collectCommodities({previous,log:message=>console.error(message)});await writeCommoditySnapshot(path,bundle);
 console.log(`Commodity snapshot: gold ${bundle.instruments.gold.rows.at(-1).date}, oil ${bundle.instruments.oil.rows.at(-1).date}`);
}
