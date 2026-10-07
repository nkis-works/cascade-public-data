import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {validateFeed} from '../src/feed-contract.js';
const b=JSON.parse(await readFile(new URL('../data/feed.json',import.meta.url)));
test('public bundle contains complete consistent daily, weekly and gold observations',()=>{assert.equal(validateFeed(b),b);});
test('invalid dates, reordered history and changed calculations are rejected',()=>{for(const mutate of [b=>b.reference_inputs.USDJPY.reverse(),b=>b.reference_inputs.EURUSD[0][0]='2026-02-30',b=>b.observatory.rows[0].reference_rate=0,b=>b.weekly.collected_at='2099-01-01T00:00:00.000Z']){const v=structuredClone(b);mutate(v);assert.throws(()=>validateFeed(v));}});
