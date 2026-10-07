import {referenceSeries,frameFromSeries} from './reference.js';
const ECB_URL = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD+GBP+JPY.EUR.SP00.A?lastNObservations=320&format=csvdata&detail=dataonly';


const CFTC = {
  EURUSD: {dataset:'gpe5-46if', code:'099741', kind:'tff', orientation:1},
  GBPUSD: {dataset:'gpe5-46if', code:'096742', kind:'tff', orientation:1},
  USDJPY: {dataset:'gpe5-46if', code:'097741', kind:'tff', orientation:-1},
  XAUUSD: {dataset:'72hh-3qpy', code:'088691', kind:'disagg', orientation:1}
};

function n(row, key) {
  const v = row?.[key];
  if (v === undefined || v === null || String(v).trim() === '') throw new Error(`missing numeric field ${key}`);
  const x = Number(v);
  if (!Number.isSafeInteger(x) || x < 0) throw new Error(`bad numeric field ${key}`);
  return x;
}

function parseCftc(instrument, row) {
  const cfg = CFTC[instrument];
  if (!cfg || row.cftc_contract_market_code !== cfg.code) throw new Error('CFTC contract mismatch');
  const reportDate = validDate(String(row.report_date_as_yyyy_mm_dd).slice(0,10));
  const oi = n(row, 'open_interest_all');
  if (!(oi > 0)) throw new Error('invalid open interest');
  let longPos, shortPos;
  if (cfg.kind === 'tff') {
    longPos = n(row,'asset_mgr_positions_long') + n(row,'lev_money_positions_long');
    shortPos = n(row,'asset_mgr_positions_short') + n(row,'lev_money_positions_short');
  } else {
    longPos = n(row,'m_money_positions_long_all');
    shortPos = n(row,'m_money_positions_short_all');
  }
  if (longPos > oi || shortPos > oi) throw new Error('CFTC positions exceed open interest');
  const specNet = (longPos - shortPos) * cfg.orientation;
  const netOi = specNet / oi;
  const cotBias = Math.tanh(netOi / 0.18);
  return {
    schema:'CASCADE_CFTC_CONTEXT_1',
    instrument,
    report_date:reportDate,
    market_name:row.market_and_exchange_names || row.contract_market_name || instrument,
    open_interest:oi,
    spec_long:longPos,
    spec_short:shortPos,
    spec_net:specNet,
    net_oi:Number(netOi.toFixed(6)),
    cot_bias:Number(cotBias.toFixed(6)),
    source_dataset_id:cfg.kind === 'tff' ? 'CFTC_TFF_FUTURES_ONLY_WEEKLY' : 'CFTC_DISAGG_FUTURES_ONLY_WEEKLY',
    report_type:'FutOnly',
    source_record_id:row.id || null,
    rights_status:'PRODUCTION-CANDIDATE',
    signal_role:'CONTEXT_ONLY',
    trading_signal:'DISABLED'
  };
}

function parseCsvLine(line) {
  const out=[]; let cur='', q=false;
  for (let i=0;i<line.length;i++) {
    const ch=line[i];
    if (ch==='"') { if(q && line[i+1]==='"'){cur+='"';i++;} else q=!q; }
    else if (ch===',' && !q) { out.push(cur); cur=''; }
    else cur+=ch;
  }
  if(q) throw new Error('CSV unmatched quote');
  out.push(cur); return out;
}
function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid date');
  const ms=Date.parse(date+'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10)!==date || date > new Date().toISOString().slice(0,10)) throw new Error('invalid/future date');
  return date;
}
function parseEcbCsv(text) {
  const lines=String(text).trim().split(/\r?\n/).filter(Boolean);
  if(lines.length<2) throw new Error('ECB csv empty');
  const head=parseCsvLine(lines.shift()), idx=Object.fromEntries(head.map((k,i)=>[k,i]));
  if(new Set(head).size!==head.length) throw new Error('ECB duplicate columns');
  for(const k of ['KEY','FREQ','CURRENCY','CURRENCY_DENOM','EXR_TYPE','EXR_SUFFIX','TIME_PERIOD','OBS_VALUE']) if(idx[k]===undefined) throw new Error(`ECB missing ${k}`);
  const byDate={};
  for(const line of lines){
    const a=parseCsvLine(line), get=k=>a[idx[k]], ccy=get('CURRENCY');
    if(a.length!==head.length || !['USD','GBP','JPY'].includes(ccy) || get('FREQ')!=='D' || get('CURRENCY_DENOM')!=='EUR' || get('EXR_TYPE')!=='SP00' || get('EXR_SUFFIX')!=='A' || get('KEY')!==`EXR.D.${ccy}.EUR.SP00.A`) throw new Error('ECB series/schema mismatch');
    const date=validDate(get('TIME_PERIOD')), val=Number(get('OBS_VALUE'));
    if(!String(get('OBS_VALUE')).trim() || !Number.isFinite(val) || val<=0) throw new Error('ECB invalid value');
    const m=(byDate[date] ||= {});
    if(Object.hasOwn(m,ccy)) throw new Error('ECB duplicate observation');
    m[ccy]=val;
  }
  const out={EURUSD:[],GBPUSD:[],USDJPY:[]};
  for(const date of Object.keys(byDate).sort()){
    const m=byDate[date];
    if(Object.keys(m).length!==3) throw new Error('ECB missing currency');
    out.EURUSD.push([date,m.USD]);out.GBPUSD.push([date,m.USD/m.GBP]);out.USDJPY.push([date,m.JPY/m.USD]);
  }
  return out;
}
function referenceFrame(instrument, pts) {
  return frameFromSeries(instrument, referenceSeries(pts), ECB_URL);
}

// Official CSV layouts: CFTC cotvariablestfm (TFF) and CFTC_023168 (disaggregated).
const CFTC_URLS={tff:'https://www.cftc.gov/dea/newcot/FinFutWk.txt',disagg:'https://www.cftc.gov/dea/newcot/f_disagg.txt'};
function parseWeekly(text,kind) {
  const rows=text.trim().split(/\r?\n/).filter(Boolean).map(parseCsvLine), out={};
  for(const [instrument,cfg] of Object.entries(CFTC).filter(([,c])=>c.kind===kind)) {
    const matches=rows.filter(r=>r[3]?.trim()===cfg.code);
    if(matches.length!==1) throw new Error('CFTC missing/duplicate contract');
    const r=matches[0].map(x=>x.trim()), width=kind==='tff'?87:191;
    if(r.length!==width || r.at(-1)!=='FutOnly') throw new Error('CFTC schema/report mismatch');
    const date=validDate(r[2]);
    if(r[1]!==date.slice(2).replaceAll('-','')) throw new Error('CFTC date mismatch');
    const row={cftc_contract_market_code:r[3],report_date_as_yyyy_mm_dd:date,market_and_exchange_names:r[0],open_interest_all:r[7]};
    if(kind==='tff') Object.assign(row,{asset_mgr_positions_long:r[11],asset_mgr_positions_short:r[12],lev_money_positions_long:r[14],lev_money_positions_short:r[15]});
    else Object.assign(row,{m_money_positions_long_all:r[13],m_money_positions_short_all:r[14]});
    out[instrument]=parseCftc(instrument,row);
  }
  return {instruments:out,record_count:rows.length};
}
async function fetchText(url,fetcher=fetch) {
  let last;
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const res=await fetcher(url,{headers:{Accept:'text/csv,text/plain','User-Agent':'CASCADE/1.3.1 private research preview'},signal:AbortSignal.timeout(20000),cf:{cacheTtl:21600,cacheEverything:true}});
      if(!res.ok) { const e=new Error(`upstream HTTP ${res.status}`);e.retryable=res.status===429 || res.status>=500;throw e; }
      if(Number(res.headers.get('content-length')||0)>2000000) throw new Error('source too large');
      const raw=await res.text(); if(new TextEncoder().encode(raw).length>2000000) throw new Error('source too large');
      return {url,http_status:res.status,retrieved_at:new Date().toISOString(),raw};
    } catch(e) {last=e;if(e.retryable===false)break;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));}
  }
  throw last;
}
async function fetchSource(source,fetcher=fetch) {
  if(source==='CFTC') {
    const raws=[], instruments={};
    for(const kind of ['tff','disagg']){
      const raw=await fetchText(CFTC_URLS[kind],fetcher), parsed=parseWeekly(raw.raw,kind);
      Object.assign(instruments,parsed.instruments);raw.record_count=parsed.record_count;raws.push(raw);
    }
    const dates=new Set(Object.values(instruments).map(x=>x.report_date));
    if(dates.size!==1) throw new Error('CFTC report dates differ');
    return {source,source_timestamp:[...dates][0],normalized:{instruments},raws};
  }
  if(source!=='ECB') throw new Error('unknown source');
  const raw=await fetchText(ECB_URL,fetcher), observations=parseEcbCsv(raw.raw);
  raw.record_count=observations.EURUSD.length*3;
  const instruments=Object.fromEntries(Object.entries(observations).map(([k,v])=>[k,referenceFrame(k,v)]));
  return {source,source_timestamp:instruments.EURUSD.reference_date,normalized:{instruments,observations},raws:[raw]};
}
export {CFTC,ECB_URL,CFTC_URLS,validDate,parseCsvLine,parseCftc,parseEcbCsv,parseWeekly,referenceFrame,fetchSource};
