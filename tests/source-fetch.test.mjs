import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fetchSourceBytes, sourceFailureReason} from '../scripts/source-fetch.mjs';
import {collectFeed} from '../scripts/collect-feed.mjs';

const URL = 'https://publicreporting.cftc.gov/resource/example.json';
const json = (body = '[]', options = {}) => new Response(body, {...options, headers: {'content-type': 'application/json', ...options.headers}});
const options = {accept: 'application/json', maxBytes: 100, random: () => 0};

test('transient network and HTTP failures recover on the third attempt', async () => {
  let calls = 0; const waits = [];
  const result = await fetchSourceBytes(URL, {...options, fetcher: async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed: secret credential');
    return calls === 2 ? json('', {status: 503}) : json('[1]');
  }, sleep: async ms => waits.push(ms)});
  assert.equal(result.buffer.toString(), '[1]');
  assert.equal(calls, 3); assert.deepEqual(waits, [250, 500]);
});

test('all specified transient HTTP statuses stop after three attempts', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let calls = 0, waits = 0;
    await assert.rejects(fetchSourceBytes(URL, {...options, fetcher: async () => { calls++; return json('', {status}); }, sleep: async () => { waits++; }}), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 3); assert.equal(waits, 2);
  }
});

test('permanent HTTP failures and unexpected exceptions do not retry', async () => {
  for (const status of [400, 401, 403, 404, 422, 501]) {
    let calls = 0;
    await assert.rejects(fetchSourceBytes(URL, {...options, fetcher: async () => { calls++; return json('', {status}); }, sleep: async () => assert.fail('unexpected retry')}), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(fetchSourceBytes(URL, {...options, fetcher: async () => {calls++; throw Error('unexpected programmer error');}}), /unexpected programmer error/);
  assert.equal(calls, 1);
});

test('Retry-After seconds and dates are bounded to two seconds', async () => {
  for (const value of ['999999', new Date(Date.now() + 3600000).toUTCString()]) {
    let calls = 0; const waits = [];
    await fetchSourceBytes(URL, {...options, fetcher: async () => ++calls < 3 ? json('', {status: 429, headers: {'retry-after': value}}) : json(), sleep: async ms => waits.push(ms)});
    assert.equal(calls, 3); assert.deepEqual(waits, [2000, 2000]);
  }
  const waits = []; let calls = 0;
  await fetchSourceBytes(URL, {...options, random: () => 1, fetcher: async () => ++calls < 3 ? json('', {status: 503, headers: {'retry-after': 'invalid'}}) : json(), sleep: async ms => waits.push(ms)});
  assert.deepEqual(waits, [375, 625]);
});

test('external abort during retry wait prevents another fetch', async () => {
  const controller = new AbortController(); let calls = 0;
  const reason = new DOMException('cancelled', 'AbortError');
  const result = fetchSourceBytes(URL, {...options, signal: controller.signal, fetcher: async () => { calls++; setTimeout(() => controller.abort(reason), 5); return json('', {status: 503}); }});
  await assert.rejects(result, error => error === reason);
  assert.equal(calls, 1);
  await assert.rejects(fetchSourceBytes(URL, {...options, signal: controller.signal, fetcher: async () => assert.fail('fetch after abort')}), error => error === reason);
});

test('external abort during fetch is propagated without retries', async () => {
  const controller = new AbortController(); let calls = 0;
  const reason = new DOMException('cancelled', 'AbortError');
  await assert.rejects(fetchSourceBytes(URL, {...options, signal: controller.signal, fetcher: async (_url, {signal}) => {
    calls++; controller.abort(reason); signal.throwIfAborted();
  }}), error => error === reason);
  assert.equal(calls, 1);
});

test('per-attempt timeouts can recover with bounded retries', async () => {
  let calls = 0;
  const result = await fetchSourceBytes(URL, {...options, timeoutMs: 5, sleep: async () => {}, fetcher: async (_url, {signal}) => {
    if (++calls === 2) return json();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('timeout did not fire')), 100);
      signal.addEventListener('abort', () => {clearTimeout(timer); reject(signal.reason);}, {once: true});
    });
  }});
  assert.equal(result.buffer.toString(), '[]'); assert.equal(calls, 2);
});

test('declared and streamed oversized content are rejected without retries', async () => {
  for (const response of [json('[]', {headers: {'content-length': '101'}}), json('x'.repeat(101))]) {
    let calls = 0;
    await assert.rejects(fetchSourceBytes(URL, {...options, fetcher: async () => {calls++; return response;}, sleep: async () => assert.fail('unexpected retry')}), /size limit/);
    assert.equal(calls, 1);
  }
  let cancelled = false;
  const stream = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(101));}, cancel() {cancelled = true;}});
  await assert.rejects(fetchSourceBytes(URL, {...options, fetcher: async () => new Response(stream, {headers: {'content-type': 'application/json'}})}), /size limit/);
  assert.equal(cancelled, true);
});

test('content type and cross-origin redirects are permanent failures', async () => {
  for (const response of [new Response('html', {headers: {'content-type': 'text/html'}}), json('', {status: 302, headers: {location: 'https://other.example/source'}}), json('', {status: 302, headers: {location: 'http://publicreporting.cftc.gov/source'}})]) {
    let calls = 0;
    await assert.rejects(fetchSourceBytes(URL, {...options, fetcher: async () => {calls++; return response;}, sleep: async () => assert.fail('unexpected retry')}), /content type|redirect/);
    assert.equal(calls, 1);
  }
});

test('same-origin redirects preserve manual handling and have a hop limit', async () => {
  const urls = [];
  await fetchSourceBytes(URL, {...options, fetcher: async (url, init) => {
    urls.push(url); assert.equal(init.redirect, 'manual');
    return urls.length === 1 ? json('', {status: 302, headers: {location: '/next.json'}}) : json();
  }});
  assert.deepEqual(urls, [URL, 'https://publicreporting.cftc.gov/next.json']);
  let calls = 0;
  await assert.rejects(fetchSourceBytes(URL, {...options, fetcher: async () => {calls++; return json('', {status: 302, headers: {location: '/loop'}});}}), /redirect/);
  assert.equal(calls, 4);
});

test('collector invalid JSON and invalid schema are not retried or written', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cascade-source-test-'));
  const logs = []; t.mock.method(console, 'error', message => logs.push(message));
  try {
    for (const goldBody of ['not JSON', '[{}]']) {
      let ecbCalls = 0, goldCalls = 0, weeklyCalls = 0;
      await assert.rejects(collectFeed({file: path.join(dir, 'missing.json'), fetcher: async url => {
        if (String(url).includes('ecb.europa.eu')) {ecbCalls++; return new Response('invalid csv', {headers: {'content-type': 'text/csv'}});}
        goldCalls++; return json(goldBody);
      }, buildWeekly: async () => {weeklyCalls++; throw Error('sensitive validation text');}}), /Initial daily and weekly/);
      assert.equal(ecbCalls, 1); assert.equal(goldCalls, 1); assert.equal(weeklyCalls, 1);
    }
    assert.equal(logs.length, 6);
    assert.ok(logs.every(message => /^Source (ECB|CFTC FX|CFTC gold) failed: invalid source data$/.test(message)));
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('failure summaries never expose original network error messages', async () => {
  try {await fetchSourceBytes(URL, {...options, fetcher: async () => {throw new TypeError('https://user:password@example.com private response');}, sleep: async () => {}});}
  catch (error) {assert.equal(sourceFailureReason(error), 'network error'); assert.equal(error.message, 'network error');}
  assert.equal(sourceFailureReason(Error('private response')), 'invalid source data');
});

test('CFTC default page fetch does not retry invalid JSON or page schema', async t => {
  const {buildPositioning} = await import('../scripts/build-positioning.mjs');
  for (const body of ['invalid JSON', '{}']) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {calls++; return json(body);});
    await assert.rejects(buildPositioning({startDate: '2025-01-01'}));
    assert.equal(calls, 1); mock.mock.restore();
  }
  let calls = 0;
  await assert.rejects(buildPositioning({startDate: '2025-01-01', fetchPageFn: async (url, signal) => {
    calls++; assert.ok(url.includes('%24limit=1000')); assert.equal(signal, undefined);
    return {rows: [], evidence: {url}};
  }}), /CFTC returned no rows/);
  assert.equal(calls, 1);
});

test('external abort cancels a stalled streaming response', async () => {
  const controller = new AbortController(); let cancelled = false, calls = 0;
  const reason = new DOMException('cancelled', 'AbortError');
  const stream = new ReadableStream({start() {setTimeout(() => controller.abort(reason), 5);}, cancel() {cancelled = true;}});
  await assert.rejects(fetchSourceBytes(URL, {...options, signal: controller.signal, fetcher: async () => {calls++; return new Response(stream, {headers: {'content-type': 'application/json'}});}}), error => error === reason);
  assert.equal(calls, 1); assert.equal(cancelled, true);
});
