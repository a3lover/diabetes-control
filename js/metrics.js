// Показатели компенсации по данным непрерывного мониторинга. Значения в ммоль/л.
// Диапазоны и цели: международный консенсус по времени в диапазоне (Battelino et al., 2019).
// GRI: индекс гликемического риска (Klonoff et al., 2022).

import { ymd, DAY } from './logic.js';

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function lowerBound(arr, ts) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][0] < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Типичный шаг между измерениями, мс. */
export function sampleInterval(readings) {
  const diffs = [];
  for (let i = 1; i < readings.length && diffs.length < 3000; i++) {
    const d = readings[i][0] - readings[i - 1][0];
    if (d > 0 && d <= 20 * 60000) diffs.push(d);
  }
  if (!diffs.length) return 5 * 60000;
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1];
}

export function griZone(gri) {
  return gri <= 20 ? 'A' : gri <= 40 ? 'B' : gri <= 60 ? 'C' : gri <= 80 ? 'D' : 'E';
}

/** all: [[ts, ммоль/л]] по возрастанию времени. Период [from, to). */
export function analyze(all, from, to) {
  const lo = lowerBound(all, from);
  const hi = lowerBound(all, to);
  const n = hi - lo;
  if (n < 12) return null;
  const r = all.slice(lo, hi);
  const step = sampleInterval(r);

  const c = { vlow: 0, low: 0, inr: 0, high: 0, vhigh: 0 };
  let sum = 0;
  let sq = 0;
  const bins = Array.from({ length: 48 }, () => []);
  const dayMap = new Map();

  let hypoEpisodes = 0;
  let epStart = null;
  let epLast = null;
  const closeEpisode = () => {
    if (epStart != null && epLast - epStart + step >= 15 * 60000) hypoEpisodes++;
    epStart = epLast = null;
  };

  for (const [ts, v] of r) {
    sum += v;
    sq += v * v;
    const bucket = v < 3.0 ? 'vlow' : v < 3.9 ? 'low' : v <= 10.0 ? 'inr' : v <= 13.9 ? 'high' : 'vhigh';
    c[bucket]++;

    const d = new Date(ts);
    bins[d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0)].push(v);

    const key = ymd(ts);
    let day = dayMap.get(key);
    if (!day) dayMap.set(key, (day = { date: key, n: 0, below: 0, inr: 0, above: 0, sum: 0 }));
    day.n++;
    day.sum += v;
    if (v < 3.9) day.below++;
    else if (v <= 10.0) day.inr++;
    else day.above++;

    if (v < 3.9) {
      if (epStart != null && ts - epLast > 30 * 60000) closeEpisode();
      if (epStart == null) epStart = ts;
      epLast = ts;
    } else if (epStart != null) {
      closeEpisode();
    }
  }
  closeEpisode();

  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  const pct = {};
  for (const k of Object.keys(c)) pct[k] = (c[k] / n) * 100;
  const gri = Math.min(100, 3.0 * pct.vlow + 2.4 * pct.low + 1.6 * pct.vhigh + 0.8 * pct.high);

  const agp = bins.map((b) => {
    if (b.length < 3) return null;
    b.sort((x, y) => x - y);
    return { p5: percentile(b, 0.05), p25: percentile(b, 0.25), p50: percentile(b, 0.5), p75: percentile(b, 0.75), p95: percentile(b, 0.95) };
  });

  return {
    n,
    step,
    from,
    to,
    first: r[0][0],
    last: r[n - 1][0],
    coverage: Math.min(1, (n * step) / (to - from)),
    mean,
    sd,
    cv: (sd / mean) * 100,
    gmi: 3.31 + 0.02392 * mean * 18.016,
    pct,
    gri,
    zone: griZone(gri),
    hypoEpisodes,
    agp,
    days: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Цели консенсуса для взрослых с диабетом 1 типа. */
export function targets(a) {
  const below = a.pct.vlow + a.pct.low;
  const above = a.pct.high + a.pct.vhigh;
  return [
    { label: 'В цели 3,9–10,0', goal: 'не меньше 70%', value: a.pct.inr, ok: a.pct.inr >= 70 },
    { label: 'Ниже 3,9', goal: 'меньше 4%', value: below, ok: below < 4 },
    { label: 'Ниже 3,0', goal: 'меньше 1%', value: a.pct.vlow, ok: a.pct.vlow < 1 },
    { label: 'Выше 10,0', goal: 'меньше 25%', value: above, ok: above < 25 },
    { label: 'Выше 13,9', goal: 'меньше 5%', value: a.pct.vhigh, ok: a.pct.vhigh < 5 },
    { label: 'Вариабельность', goal: 'не выше 36%', value: a.cv, ok: a.cv <= 36 },
  ];
}

/** Средние по дням помпы за период [from, to). */
export function pumpStats(pump, from, to) {
  const a = ymd(from);
  const b = ymd(to - 1);
  let days = 0;
  let bolus = 0;
  let carbs = 0;
  let count = 0;
  let basal = 0;
  let basalDays = 0;
  let prime = 0;
  for (const [date, d] of Object.entries(pump.days || {})) {
    if (date < a || date > b) continue;
    days++;
    bolus += d.bolus || 0;
    carbs += d.carbs || 0;
    count += d.boluses || 0;
    prime += d.prime || 0;
    if (d.basal != null) {
      basal += d.basal;
      basalDays++;
    }
  }
  if (!days) return null;
  const avgBolus = bolus / days;
  const avgBasal = basalDays ? basal / basalDays : null;
  const tdd = avgBasal == null ? null : avgBolus + avgBasal;
  return {
    days,
    bolus: avgBolus,
    basal: avgBasal,
    tdd,
    // Заполнение трубки и канюли: в организм не попадает, но из запаса уходит.
    prime: prime / days,
    use: tdd == null ? null : tdd + prime / days,
    carbs: carbs / days,
    carbUnit: pump.carbUnit === 'ex' ? 'ex' : 'g',
    boluses: count / days,
  };
}

export { DAY };
