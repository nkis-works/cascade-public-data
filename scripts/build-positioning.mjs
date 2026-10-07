#!/usr/bin/env node
// Free, public, read-only CFTC TFF Futures Only API. No account/key is required.
// Usage: node scripts/build-positioning.mjs [--start YYYY-MM-DD]
// Re-downloads from the source every run. A failed run leaves both outputs intact.
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, rm} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {POSITIONING_SCHEMA, POSITIONING_PAIRS, validPositioningDataset} from '../src/positioning.js';

const BASE = 'https://publicreporting.cftc.gov/resource/gpe5-46if.json';
const CODES = {USDJPY: '097741', EURUSD: '099741', GBPUSD: '096742'};
const PAIR_BY_CODE = Object.fromEntries(Object.entries(CODES).map(([pair, code]) => [code, pair]));
const FIELDS = ['id', 'report_date_as_yyyy_mm_dd', 'cftc_contract_market_code', 'market_and_exchange_names', 'open_interest_all', 'asset_mgr_positions_long', 'asset_mgr_positions_short', 'lev_money_positions_long', 'lev_money_positions_short', 'futonly_or_combined'];
const LIMIT = 1000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const dateValid = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
const number = (row, key) => {
  const value = row[key];
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${key}`);
  return Number(value);
};

export function parsePositioningRows(rows, collectedAt, sourceUrls, startDate) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('CFTC returned no rows');
  const instruments = Object.fromEntries(POSITIONING_PAIRS.map(pair => [pair, []]));
  const ids = new Set(), observations = new Set();
  for (const row of rows) {
    if (!row || FIELDS.some(field => !Object.hasOwn(row, field))) throw new Error('CFTC required field missing');
    const pair = PAIR_BY_CODE[row.cftc_contract_market_code];
    const timestamp = row.report_date_as_yyyy_mm_dd;
    if (!pair || row.futonly_or_combined !== 'FutOnly' || typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?$/.test(timestamp)) throw new Error('CFTC contract/report/date schema mismatch');
    const date = timestamp.slice(0, 10);
    if (!dateValid(date) || date < startDate || date > collectedAt.slice(0, 10)) throw new Error('CFTC date outside requested period');
    const id = date.slice(2).replaceAll('-', '') + CODES[pair] + 'F';
    if (row.id !== id || ids.has(id) || observations.has(`${pair}:${date}`)) throw new Error('CFTC duplicate or inconsistent record identifier');
    ids.add(id); observations.add(`${pair}:${date}`);
    instruments[pair].push({date, oi: number(row, 'open_interest_all'),
      asset: {long: number(row, 'asset_mgr_positions_long'), short: number(row, 'asset_mgr_positions_short')},
      leveraged: {long: number(row, 'lev_money_positions_long'), short: number(row, 'lev_money_positions_short')}});
  }
  for (const values of Object.values(instruments)) values.sort((a, b) => a.date.localeCompare(b.date));
  const dataset = {schema: POSITIONING_SCHEMA, collected_at: collectedAt, source_urls: sourceUrls, instruments};
  if (!validPositioningDataset(dataset)) throw new Error('Invalid, incomplete or misaligned CFTC histories');
  if (Object.values(instruments).some(values => values.length < 53)) throw new Error('CFTC history has fewer than 53 reports per contract');
  return dataset;
}

async function fetchPage(url, signal) {
  const response = await fetch(url, {headers: {Accept: 'application/json', 'User-Agent': 'CASCADE/1.4 private research preview'}, cache: 'no-store', signal: signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`CFTC HTTP ${response.status}`);
  if (response.url && new URL(response.url).hostname !== 'publicreporting.cftc.gov') throw new Error('Unexpected CFTC redirect');
  if (!response.headers.get('content-type')?.includes('json')) throw new Error('CFTC non-JSON response');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 4000000) throw new Error('CFTC page exceeds size limit');
  const raw = buffer.toString('utf8'), rows = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.length > LIMIT) throw new Error('CFTC response/page schema mismatch');
  return {rows, evidence: {url, retrieved_at: new Date().toISOString(), http_status: response.status,
    source_last_modified: response.headers.get('last-modified'), response_date: response.headers.get('date'),
    bytes: buffer.length, sha256: sha256(buffer), row_count: rows.length, raw_body: raw}};
}

export async function buildPositioning({startDate = `${new Date().getUTCFullYear() - 4}-01-01`, fetchPageFn = fetchPage, signal} = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (!dateValid(startDate) || startDate > today) throw new Error('Invalid start date');
  const rows = [], sources = [];
  for (let offset = 0; offset < 6000; offset += LIMIT) {
    const url = new URL(BASE);
    url.search = new URLSearchParams({
      '$select': FIELDS.join(','),
      '$where': `cftc_contract_market_code in ('097741','099741','096742') AND report_date_as_yyyy_mm_dd >= '${startDate}T00:00:00.000' AND report_date_as_yyyy_mm_dd <= '${today}T00:00:00.000'`,
      '$order': 'report_date_as_yyyy_mm_dd ASC,cftc_contract_market_code ASC', '$limit': String(LIMIT), '$offset': String(offset),
    });
    signal?.throwIfAborted();
    const page = await fetchPageFn(url.href,signal);
    rows.push(...page.rows); sources.push(page.evidence);
    if (page.rows.length < LIMIT) break;
    if (offset === 5000) throw new Error('CFTC pagination exceeded record limit');
  }
  const collectedAt = new Date().toISOString();
  const dataset = parsePositioningRows(rows, collectedAt, sources.map(source => source.url), startDate);
  const audit = Object.fromEntries(Object.entries(dataset.instruments).map(([pair, values]) => {
    const gaps = values.slice(1).map((row, i) => ({previous_date: values[i].date, date: row.date, days: (Date.parse(row.date) - Date.parse(values[i].date)) / 86400000})).filter(gap => gap.days !== 7);
    return [pair, {contract_code: CODES[pair], row_count: values.length, first_report_date: values[0].date, last_report_date: values.at(-1).date, duplicates: 0, missing_required_values: 0, non_seven_day_intervals: gaps, intervals_over_eight_days: gaps.filter(gap => gap.days > 8).length}];
  }));
  const dataText = JSON.stringify(dataset, null, 2) + '\n';
  const provenance = {
    schema: 'CASCADE_POSITIONING_PROVENANCE_1', collected_at: collectedAt,
    dataset_id: 'gpe5-46if', report_type: 'TFF Futures Only', requested_start_date: startDate,
    source_documentation: ['https://publicreportinghub.cftc.gov/d/gpe5-46if', 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/HistoricalViewable/cotvariablestfm'],
    source_columns: FIELDS, sources, total_source_rows: rows.length, total_output_rows: rows.length,
    output_sha256: sha256(dataText), instruments: audit,
    validation: {status: 'PASS', missing_contract_dates: 0, duplicate_contract_dates: 0, rejected_rows: 0, future_report_dates: 0},
    units: {oi: 'futures contracts', long: 'futures contracts', short: 'futures contracts', netOi: '(oriented long - oriented short) / open interest'},
    transformations: ['Select the three exact CFTC contract codes; retain Asset Manager and Leveraged Money separately.', 'Validate required fields, Futures Only flag, date-derived record ID, integer counts, open-interest bounds and aligned dates.', 'Sort each series by report date. Preserve original futures direction in the JSON; invert JPY long/short only in positioningReading. No interpolation or imputation.'],
    limitations: ['Report date is the positions-as-of date, not the publication date or an intraday timestamp.', 'The API supplies its current historical vintage; historical revisions and original publication timestamps are not archived here. This dataset must not be used as point-in-time backtest evidence.', 'Weekly positioning is descriptive; neither a price forecast nor a trading signal.', 'Futures trader categories do not represent the entire spot-FX market. Long/short fields exclude each category\'s separate spreading field.', 'Retrieval time does not establish report freshness. Use each last_report_date; unsuccessful rebuilds preserve the previous dataset and timestamp.'],
  };
  return {dataset, provenance, dataText};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--start')) throw new Error('Usage: node scripts/build-positioning.mjs [--start YYYY-MM-DD]');
  const result = await buildPositioning({startDate: args[1]});
  const dir = fileURLToPath(new URL('../data/', import.meta.url));
  await mkdir(dir, {recursive: true});
  const outputs = [[`${dir}/positioning-history.json`, result.dataText], [`${dir}/positioning-provenance.json`, JSON.stringify(result.provenance, null, 2) + '\n']];
  // Fetching, parsing and all validation finish before touching existing outputs.
  const previous = await Promise.all(outputs.map(async ([path]) => {try {return await readFile(path);} catch (error) {if (error.code === 'ENOENT') return null; throw error;}}));
  try {
    for (const [path, text] of outputs) await writeFile(path + '.tmp', text);
    for (const [path] of outputs) await rename(path + '.tmp', path);
  } catch (error) {
    for (let i = 0; i < outputs.length; i++) {
      const path = outputs[i][0];
      if (previous[i] === null) await rm(path, {force: true}); else await writeFile(path, previous[i]);
      await rm(path + '.tmp', {force: true});
    }
    throw error;
  }
  console.log(JSON.stringify({status: 'PASS', collected_at: result.dataset.collected_at, sha256: result.provenance.output_sha256, instruments: result.provenance.instruments}, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {console.error(`Positioning update failed: ${error.message}`); process.exitCode = 1;});
