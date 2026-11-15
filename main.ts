// polymarket-faa-attribution-01 entry — empirical-delta-quantiles shrunk 25% toward house baseline.
// Deterministic, no randomness, no clock, no network. Node 22 standard lib only.
'use strict';
const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantile at each level, matches the house starter exactly. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
const SIGMA_HOUSE = 0.0025;
/** Shrinkage factor toward the house baseline: 0=fully empirical, 1=fully baseline. */
const SHRINK = 0.25;
/** Minimum usable h-step samples before falling back to baseline. */
const MIN_SAMPLES = 40;

/** x clamped to [0,1] and rounded to 6 decimals (+0 removes negative-zero). */
const price6 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** Linear-interpolation quantile on a sorted numeric array; NaN if empty. */
function quantile(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  const k = p * (n - 1);
  const lo = Math.floor(k), hi = Math.min(n - 1, lo + 1);
  const t = k - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

/** Sort numbers ascending in-place and return. */
const sortNum = (a) => { a.sort((x, y) => x - y); return a; };

/** The house-baseline row for horizon h: persistence-centered Gaussian spread. */
function baselineRow(x, h) {
  return Z.map((z) => price6(x + z * SIGMA_HOUSE * Math.sqrt(h)));
}

/** Empirical-quantile forecast for one market, returning [[q05,q25,...], …H rows]. */
function forecast(market, horizon) {
  const prices = market.prices;
  if (!Array.isArray(prices) || prices.length === 0) throw new Error(`market ${market.id} has no prices`);
  const x = prices[prices.length - 1];
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`market ${market.id}'s last price invalid`);
  const rows = [];
  for (let h = 1; h <= horizon; h++) {
    const deltas = [];
    for (let j = 0; j <= prices.length - h - 1; j++) {
      const d = prices[j + h] - prices[j];
      if (Math.abs(d) < 0.001) continue; // ignore near-zero moves, reduces noise
      deltas.push(d);
    }
    if (deltas.length < MIN_SAMPLES) {
      rows.push(baselineRow(x, h));
      continue;
    }
    const ds = sortNum(deltas.slice());
    const empQ = QUANTILES.map((tau) => quantile(ds, tau));
    const baseQ = baselineRow(x, h);
    rows.push(empQ.map((eq, ti) => price6(SHRINK * eq + (1 - SHRINK) * (baseQ[ti] - x) + x)));
  }
  // enforce non-decreasing across quantile levels within each row
  for (let h = 0; h < rows.length; h++) {
    rows[h] = sortNum(rows[h]);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  try {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8'));
    if (c.quantiles.length !== QUANTILES.length ||
        c.quantiles.some((t, j) => Math.abs(t - QUANTILES[j]) > 1e-9)) {
      throw new Error(`${file}: quantiles ${JSON.stringify(c.quantiles)} differ from required`);
    }
    const forecasts = c.markets.map((m) => ({
      id: m.id,
      q: forecast(m, c.horizon_minutes),
    }));
    writeFileSync(join(OUTPUT_DIR, `${id}.out`),
      JSON.stringify({ forecasts }) + '\n');
  } catch (e) {
    // malformed or out-of-spec → invalid case: all-0.5 barred output
    writeFileSync(join(OUTPUT_DIR, `${id}.out`),
      JSON.stringify({ forecasts: [] }) + '\n');
    console.error(`[WARN] ${file}: ${e.message}`);
  }
}
