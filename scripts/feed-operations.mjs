import {readFile,appendFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {prepareBackup,REPLICA_PUBLICATION_PATHS} from './prepare-backup.mjs';
import {FEED_INTERVAL} from '../src/feed-contract.js';
import {feedHealth,oilHealth,commodityFeedHealth,HEARTBEAT_LIMIT} from './feed-health.mjs';

export const DATA_FILES=['data/feed.json','data/oil.json','data/commodities.json'];
export const PUBLISH_FILES=[...DATA_FILES,...REPLICA_PUBLICATION_PATHS];
// A successful job or a newly stamped envelope alone never proves readiness.
// Health includes source state and observation-age allowances for release calendars.
export function collectionReadiness(bundles,{now=Date.now(),replica=undefined}={}){
 const reasons=[];
 const slot=Math.floor(now/FEED_INTERVAL);
 if(replica!==undefined){
  if(replica!==null){
   const published=Date.parse(replica.published_at);
   if(replica.schema!=='PUBLIC_MARKET_REPLICA_1'||replica.repository!=='nkis-works/cascade-public-data'||!Number.isSafeInteger(replica.slot)||replica.slot<0||replica.slot>slot||!Number.isFinite(published)||published>now||new Date(published).toISOString()!==replica.published_at||Math.floor(published/FEED_INTERVAL)!==replica.slot)throw Error('Invalid or future replica publication marker');
   if(!replica.files||Object.keys(replica.files).sort().join(',')!=='commodities,feed,oil')throw Error('Invalid replica file manifest');
   for(const name of ['feed','oil','commodities']){
    const file=replica.files[name],generated=Date.parse(file?.generated_at);
    if(file?.path!=='/data/'+name+'.json'||!/^([a-f0-9]{64})$/.test(file.sha256)||!Number.isFinite(generated)||generated>published||new Date(generated).toISOString()!==file.generated_at)throw Error('Invalid replica file metadata');
   }
  }
  if((replica===null||replica.slot<slot)&&Math.floor(Date.parse(bundles[0]?.generated_at)/FEED_INTERVAL)<slot)reasons.push('Static replica: unused UTC six-hour slot requires a current-slot collection');
 }

 for(const [index,check] of [feedHealth,oilHealth,commodityFeedHealth].entries()){
  const bundle=bundles[index],name=DATA_FILES[index];
  try{
   const health=check(bundle,{now});
   reasons.push(...health.issues.map(issue=>name+': '+issue));
   if(now-Date.parse(bundle.generated_at)>=FEED_INTERVAL)reasons.push(name+': six-hour collection interval reached');
   // Detect old individual checks even when another source refreshed the envelope.
   const checks=index===0?Object.values(bundle.outcomes):Object.values(index===1?bundle.series:bundle.instruments);
   if(checks.some(source=>now-Date.parse(source.checked_at)>HEARTBEAT_LIMIT))reasons.push(name+': source heartbeat exceeds eight hours');
  }catch(error){reasons.push(name+': invalid bundle: '+error.message);}
 }
 return {needed:reasons.length>0,reasons};
}

export async function localBundles(){return Promise.all(DATA_FILES.map(async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch{return null;}}));}

export async function localReplica(){
 try{return JSON.parse(await readFile('backup/replica.json','utf8'));}
 catch(error){if(error.code==='ENOENT')return null;throw error;}
}

function command(program,args,{authenticated=false,allowFailure=false}={}){
 // Never expose the publishing token to tests, collectors or source HTTP requests.
 const env={...process.env};if(!authenticated){delete env.GH_TOKEN;delete env.GITHUB_TOKEN;}
 const result=spawnSync(program,args,{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 if(result.stdout)process.stdout.write(result.stdout);
 if(result.stderr)process.stderr.write(result.stderr);
 if(result.error)throw result.error;
 if(result.status!==0&&!allowFailure)throw Error(program+' failed with exit '+result.status);
 return result.status;
}

// Both writers use this bounded normal-push path. A rejection discards our own
// generated commit, reloads main, and recollects; it never rebases stale data over
// another collector's data or force-pushes a replacement head.
export async function publishData({run=command,read=localBundles,now=()=>Date.now(),prepare=prepareBackup,readReplica=localReplica}={}){
 run('git',['config','user.name','github-actions[bot]']);
 run('git',['config','user.email','41898282+github-actions[bot]@users.noreply.github.com']);
 for(let attempt=0;attempt<2;attempt++){
  run('git',['add','--',...PUBLISH_FILES]);
  if(run('git',['diff','--cached','--quiet'],{allowFailure:true})===0)return 'unchanged';
  run('git',['commit','-m','Refresh validated official market data']);
  if(run('git',['-c','credential.helper=','-c','credential.helper=!gh auth git-credential','push','origin','HEAD:main'],{authenticated:true,allowFailure:true})===0)return 'published';
  run('git',['-c','credential.helper=','-c','credential.helper=!gh auth git-credential','fetch','origin','main'],{authenticated:true});
  run('git',['reset','--hard','origin/main']);
  const needed=collectionReadiness(await read(),{now:now(),replica:await readReplica()}).needed;
  if(needed&&attempt===0){
   run('npm',['test']);
   run('npm',['run','refresh']);
   run('npm',['test']);
  }
  // Re-evaluate the persisted six-hour replica slot on the fetched head. Never
  // carry an old backup manifest or backup data across a rejected push.
  const replica=await prepare({root:process.cwd(),now:now()});
  if(!needed&&!replica.changed)return 'already refreshed';
  if(attempt===1)throw Error('Publication rejected twice; latest main retained, next scheduled run will retry');
 }
}

async function main(){
 if(process.argv[2]==='publish'){
  if(process.env.GITHUB_REPOSITORY!=='nkis-works/cascade-public-data'||process.env.GITHUB_REF!=='refs/heads/main')throw Error('Publishing requires the canonical public repository main branch');
  console.log(await publishData());
 }else{
  const result=collectionReadiness(await localBundles(),{replica:await localReplica()});
  console.log(JSON.stringify(result));
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,'needed='+result.needed+'\n');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
