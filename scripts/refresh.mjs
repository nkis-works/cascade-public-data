import {readFile} from 'node:fs/promises';
import {collectCommodities,writeCommoditySnapshot} from './collect-commodities.mjs';
import {validateCommodityPositions} from '../src/commodity-positioning.js';
import {collectFeed} from './collect-feed.mjs';
import {collectOil} from './collect-oil.mjs';
import {fileURLToPath} from 'node:url';
console.log(JSON.stringify(await collectFeed({file:fileURLToPath(new URL('../data/feed.json',import.meta.url))})));
console.log(JSON.stringify(await collectOil({file:fileURLToPath(new URL('../data/oil.json',import.meta.url))})));

const commodityFile=fileURLToPath(new URL('../data/commodities.json',import.meta.url));
const previous=validateCommodityPositions(JSON.parse(await readFile(commodityFile,'utf8')));
const commodities=await collectCommodities({previous,log:message=>console.error(message)});
await writeCommoditySnapshot(commodityFile,commodities);
console.log(JSON.stringify({schema:commodities.schema,generated_at:commodities.generated_at,instruments:Object.fromEntries(Object.entries(commodities.instruments).map(([asset,series])=>[asset,{state:series.state,date:series.rows.at(-1).date}]))}));
