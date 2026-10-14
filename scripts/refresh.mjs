import {collectFeed} from './collect-feed.mjs';
import {collectOil} from './collect-oil.mjs';
import {fileURLToPath} from 'node:url';
console.log(JSON.stringify(await collectFeed({file:fileURLToPath(new URL('../data/feed.json',import.meta.url))})));
console.log(JSON.stringify(await collectOil({file:fileURLToPath(new URL('../data/oil.json',import.meta.url))})));
