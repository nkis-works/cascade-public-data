export const POSITIONING_SCHEMA = 'CASCADE_POSITIONING_1';
export const POSITIONING_PAIRS = ['USDJPY', 'EURUSD', 'GBPUSD'];
export const POSITIONING_GROUPS = ['asset', 'leveraged'];
export const POSITIONING_MIN_PRIOR = 52;
export const POSITIONING_MAX_PRIOR = 156;

const DAY = 86400000;
const dateTime = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
function validDate(date) {
  const ms = dateTime(date);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}
const count = n => Number.isSafeInteger(n) && n >= 0;

/**
 * Canonical input contract: {schema:'CASCADE_POSITIONING_1', collected_at:UTC ISO
 * timestamp, source_urls:string[], instruments:{USDJPY:Row[],EURUSD:Row[],GBPUSD:Row[]}}.
 * Row = {date:'YYYY-MM-DD',oi:positive integer,asset:{long,short},leveraged:{long,short}}.
 * Counts are unmodified futures contracts, sorted by report date, never spot lots.
 * All three histories must share their report dates. Missing/duplicate/invalid
 * records are rejected, never filled. Report dates cannot exceed collected_at.
 * No wall clock is consulted: validation and calculations are deterministic for
 * the frozen dataset. The collector supplies the actual UTC retrieval timestamp.
 */
export function validPositioningDataset(dataset) {
  if (!dataset || dataset.schema !== POSITIONING_SCHEMA || typeof dataset.collected_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(dataset.collected_at)) return false;
  const collected = Date.parse(dataset.collected_at);
  if (!Number.isFinite(collected) || new Date(collected).toISOString().replace('.000Z', 'Z') !== dataset.collected_at.replace('.000Z', 'Z')) return false;
  if (!Array.isArray(dataset.source_urls) || !dataset.source_urls.length || dataset.source_urls.some(url => {
    try { const u = new URL(url); return u.protocol !== 'https:' || !['publicreporting.cftc.gov', 'www.cftc.gov'].includes(u.hostname) || Boolean(u.username || u.password); }
    catch { return true; }
  })) return false;
  let dates;
  for (const pair of POSITIONING_PAIRS) {
    const rows = dataset.instruments?.[pair];
    if (!Array.isArray(rows) || !rows.length || rows.length > 2000) return false;
    let previous;
    for (const row of rows) {
      if (!row || !validDate(row.date) || row.date > dataset.collected_at.slice(0, 10) || (previous && row.date <= previous) || !count(row.oi) || row.oi === 0) return false;
      for (const group of POSITIONING_GROUPS) {
        const positions = row[group];
        if (!positions || !count(positions.long) || !count(positions.short) || positions.long > row.oi || positions.short > row.oi) return false;
      }
      // Categories are separate, mutually exclusive trader classifications.
      if (row.asset.long + row.leveraged.long > row.oi || row.asset.short + row.leveraged.short > row.oi) return false;
      previous = row.date;
    }
    const current = rows.map(row => row.date);
    if (dates && (dates.length !== current.length || dates.some((date, i) => date !== current[i]))) return false;
    dates = current;
  }
  return true;
}

/**
 * Returns null for invalid input. netOi/deltaNetOi are fractions, not percent.
 * pctRank is a directional 0..100 midrank (low = short-heavy, high = long-heavy)
 * against up to 156 strictly prior observations; null until 52 exist. Equal
 * values use a 1e-12 absolute tolerance. A zero net has no special rank rule.
 * USDJPY swaps the JPY futures long/short counts before every calculation.
 * Deltas are between report dates, not publication dates; a non-seven-day gap
 * is flagged so the consumer must not call it a normal weekly change.
 * Historical values reflect the latest downloaded vintage, not a point-in-time
 * archive of when a report/correction became publicly available.
 */
export function positioningReading(dataset, pair, group = 'leveraged') {
  if (!POSITIONING_PAIRS.includes(pair) || !POSITIONING_GROUPS.includes(group) || !validPositioningDataset(dataset)) return null;
  const orientation = pair === 'USDJPY' ? 'inverted' : 'direct';
  const rows = dataset.instruments[pair].map(row => {
    const positions = row[group];
    const long = orientation === 'inverted' ? positions.short : positions.long;
    const short = orientation === 'inverted' ? positions.long : positions.short;
    return {date: row.date, oi: row.oi, long, short, netOi: (long - short) / row.oi};
  });
  const latest = rows.at(-1), previous = rows.at(-2);
  const prior = rows.slice(-POSITIONING_MAX_PRIOR - 1, -1);
  const rankReady = prior.length >= POSITIONING_MIN_PRIOR;
  let below = 0, ties = 0;
  for (const row of prior) {
    if (Math.abs(row.netOi - latest.netOi) <= 1e-12) ties++;
    else if (row.netOi < latest.netOi) below++;
  }
  const weekGapDays = previous ? (dateTime(latest.date) - dateTime(previous.date)) / DAY : null;
  return {
    pair, group, orientation, latestDate: latest.date, previousDate: previous?.date ?? null,
    oi: latest.oi, long: latest.long, short: latest.short, netOi: latest.netOi,
    pctRank: rankReady ? 100 * (below + ties / 2) / prior.length : null,
    priorCount: prior.length, rankReady,
    deltaLong: previous ? latest.long - previous.long : null,
    deltaShort: previous ? latest.short - previous.short : null,
    deltaNetOi: previous ? latest.netOi - previous.netOi : null,
    weekGapDays, weeklyGapWarning: weekGapDays !== null && weekGapDays !== 7,
    comparisonStart: prior[0]?.date ?? null, comparisonEnd: prior.at(-1)?.date ?? null,
    history: rows.map(({date, netOi}) => ({date, netOi})),
  };
}
