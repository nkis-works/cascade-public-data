// Descriptive ranks, never a probability or directional trading signal.
export const FORMULA_VERSION = 'DAILY_ANOMALY_2';
export const MIN_PRIOR = 60;
export const MAX_PRIOR = 252;

export function percentile(sample, value) {
  if (sample.length < MIN_PRIOR || !Number.isFinite(value)) return null;
  // Zero movement/volatility is not an elevated state, including a flat series.
  if (value === 0) return 0;
  let below = 0, equal = 0;
  for (const x of sample) {
    const tolerance = 1e-12 * Math.max(1, Math.abs(x), Math.abs(value));
    if (Math.abs(x - value) <= tolerance) equal++;
    else if (x < value) below++;
  }
  return 100 * (below + equal / 2) / sample.length;
}

const rounded = (value, digits = 8) => value === null ? null : Number(value.toFixed(digits));
export function referenceSeries(points) {
  if (!Array.isArray(points) || !points.length || points.length > 2000) throw new Error('Invalid reference history');
  for (let i = 0; i < points.length; i++) {
    const [date, rate] = points[i];
    const parsed = Date.parse(date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0,10) !== date || date > new Date().toISOString().slice(0,10) || !Number.isFinite(rate) || rate <= 0 || (i && date <= points[i - 1][0])) throw new Error('Invalid reference observation');
  }
  const logs = [null], vols = [];
  return points.map(([date, rate], i) => {
    if (i) logs.push(Math.log(rate / points[i - 1][1]));
    let vol = null;
    if (i >= 20) {
      const sample = logs.slice(i - 19, i + 1);
      const mean = sample.reduce((a, b) => a + b, 0) / 20;
      vol = Math.sqrt(sample.reduce((sum, r) => sum + (r - mean) ** 2, 0) / 19 * 252);
    }
    vols.push(vol);
    const prior = logs.slice(Math.max(1, i - MAX_PRIOR), i);
    const priorVol = vols.slice(Math.max(20, i - MAX_PRIOR), i);
    const movePct = i ? percentile(prior.map(Math.abs), Math.abs(logs[i])) : null;
    const volPct = vol === null ? null : percentile(priorVol, vol);
    let z = null;
    if (prior.length >= MIN_PRIOR) {
      const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
      const variance = prior.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (prior.length - 1);
      z = variance > 0 ? (logs[i] - mean) / Math.sqrt(variance) : null;
    }
    return {
      date, rate: rounded(rate), daily_return: i ? rounded(rate / points[i - 1][1] - 1) : null,
      realized_vol_20d: rounded(vol), daily_move_z: rounded(z, 6),
      move_percentile_1y: rounded(movePct, 2), vol_percentile_1y: rounded(volPct, 2),
      reference_anomaly_score: movePct === null || volPct === null ? null : Math.round((movePct + volPct) / 2),
      comparison_count_move: prior.length, comparison_count_vol: priorVol.length,
    };
  });
}

export function frameFromSeries(instrument, series, sourceUrl) {
  const last = series.at(-1), previous = series.at(-2);
  if (!last) throw new Error('No reference observations');
  return {
    schema: 'CASCADE_ECB_REFERENCE_3', formula_version: FORMULA_VERSION, instrument,
    observation_count: series.length, volatility_window_count: Math.max(0, series.length - 20),
    reference_date: last.date, reference_rate: last.rate,
    daily_return: last.daily_return, realized_vol_20d: last.realized_vol_20d, daily_move_z: last.daily_move_z,
    move_percentile_1y: last.move_percentile_1y, vol_percentile_1y: last.vol_percentile_1y,
    reference_anomaly_score: last.reference_anomaly_score,
    previous_reference_date: previous?.date ?? null,
    previous_anomaly_score: previous?.reference_anomaly_score ?? null,
    anomaly_change: last.reference_anomaly_score === null || previous?.reference_anomaly_score == null ? null : last.reference_anomaly_score - previous.reference_anomaly_score,
    comparison_count_move: last.comparison_count_move, comparison_count_vol: last.comparison_count_vol,
    history_start: series[0].date, source: 'ECB_DATA_PORTAL_EXR', source_url: sourceUrl,
    rights_status: 'PRODUCTION-CANDIDATE', signal_role: 'REFERENCE_CONTEXT_ONLY', frequency: 'DAILY', trading_signal: 'DISABLED',
  };
}
