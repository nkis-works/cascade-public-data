import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {pathToFileURL,fileURLToPath} from 'node:url';import path from 'node:path';
import {validateFeed,FEED_INTERVAL} from '../src/feed-contract.js';
import {validateOil} from '../src/oil-data.js';
import {validateCommodityPositions} from '../src/commodity-positioning.js';

export const REPLICA_ORIGIN='https://nkis-market-data.pages.dev';
export const REPLICA_PUBLICATION_PATHS=['backup/data/feed.json','backup/data/oil.json','backup/data/commodities.json','backup/replica.json','backup/_headers','backup/index.html','backup/404.html','backup/robots.txt'];
const names=['feed','oil','commodities'],validators=[validateFeed,validateOil,validateCommodityPositions];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function prepareBackup({root=fileURLToPath(new URL('../',import.meta.url)),now=Date.now()}={}){
 if(!Number.isFinite(now))throw Error('Invalid replica clock');
 try{if((await lstat(root+'/backup')).isSymbolicLink())throw Error('Replica root symlink rejected');}catch(e){if(e.code!=='ENOENT')throw e;}
 async function files(dir){let entries;try{entries=await readdir(root+'/'+dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}const found=[];for(const e of entries){const file=dir+'/'+e.name;if(e.isSymbolicLink())throw Error('Replica symlink rejected');if(e.isDirectory())found.push(...await files(file));else found.push(file);}return found;}
 for(const file of await files('backup'))if(!REPLICA_PUBLICATION_PATHS.includes(file))throw Error('Unexpected replica asset: '+file);
 const slot=Math.floor(now/FEED_INTERVAL),texts=await Promise.all(names.map(n=>readFile(root+'/data/'+n+'.json','utf8'))),bundles=texts.map(JSON.parse);
 let previous=null;try{previous=JSON.parse(await readFile(root+'/backup/replica.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const old=[];
 if(previous){
  if(previous.schema!=='PUBLIC_MARKET_REPLICA_1'||!Number.isSafeInteger(previous.slot)||previous.slot>slot||!Number.isFinite(Date.parse(previous.published_at))||Math.floor(Date.parse(previous.published_at)/FEED_INTERVAL)!==previous.slot)throw Error('Invalid replica publication marker');
  for(const name of names){const text=await readFile(root+'/backup/data/'+name+'.json','utf8');if(digest(text)!==previous.files?.[name]?.sha256)throw Error('Replica hash mismatch');old.push(JSON.parse(text));}
 }
 for(const [i,validate]of validators.entries())validate(bundles[i],{now,previous:old[i]});
 if(previous?.slot===slot)return {changed:false,slot:previous.slot};
 // A new slot belongs to a collection from that slot. A healthy no-op check
 // must not publish yesterday's bundle and block the next fresh collection.
 if(Math.floor(Date.parse(bundles[0].generated_at)/FEED_INTERVAL)!==slot)return {changed:false,needsCollection:true,slot:previous?.slot??null};
 if(previous&&names.every((name,i)=>previous.files[name].sha256===digest(texts[i])))return {changed:false,slot:previous.slot};
 const filesMeta=Object.fromEntries(names.map((name,i)=>[name,{path:'/data/'+name+'.json',sha256:digest(texts[i]),generated_at:bundles[i].generated_at}]));
 const marker={schema:'PUBLIC_MARKET_REPLICA_1',slot,published_at:new Date(now).toISOString(),repository:'nkis-works/cascade-public-data',files:filesMeta};
 const assets={
  'replica.json':JSON.stringify(marker,null,2)+'\n',
  '_headers':"/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n  X-Robots-Tag: noindex, nofollow\n  Content-Security-Policy: default-src 'none'; frame-ancestors 'none'\n/data/*\n  Content-Type: application/json; charset=utf-8\n/replica.json\n  Content-Type: application/json; charset=utf-8\n",
  'index.html':'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Public reference data</title><h1>Public reference data</h1><p>Dated ECB, CFTC and EIA observations.</p></html>\n',
  '404.html':'<!doctype html><html lang="en"><meta charset="utf-8"><title>Not found</title><h1>Not found</h1></html>\n',
  'robots.txt':'User-agent: *\nDisallow: /\n'
 };
 await mkdir(root+'/backup/data',{recursive:true});
 for(const [i,name]of names.entries())await writeFile(root+'/backup/data/'+name+'.json',texts[i]);
 // The marker is written last. The caller publishes the complete directory and
 // source data in one normal Git commit; Cloudflare serves only this directory.
 for(const [file,text]of Object.entries(assets).filter(([f])=>f!=='replica.json'))await writeFile(root+'/backup/'+file,text);
 await writeFile(root+'/backup/replica.json',assets['replica.json']);return {changed:true,slot,files:REPLICA_PUBLICATION_PATHS};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)prepareBackup().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
