import {collectFeed} from './collect-feed.mjs';
import {fileURLToPath} from 'node:url';
console.log(JSON.stringify(await collectFeed({file:fileURLToPath(new URL('../data/feed.json',import.meta.url))})));
