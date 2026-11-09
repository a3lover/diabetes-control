// Разбор файлов: выгрузка CareLink (CSV) и произвольная таблица с сахарами (CSV/TSV).

import { ymd, startOfDay, DAY } from './logic.js';

const MGDL = 18.016;
const round1 = (x) => Math.round(x * 10) / 10;

export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).slice(0, 40);
  let best = ',';
  let bestN = 0;
  for (const d of [';', ',', '\t']) {
    const n = lines.reduce((s, l) => s + (l.split(d).length - 1), 0);
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

export function parseCSV(text, delim = detectDelimiter(text)) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function num(s) {
  if (s == null) return null;
  s = String(s).trim().replace(/\s/g, '').replace(',', '.');
  if (s === '' || isNaN(s)) return null;
  return Number(s);
}

/** Дата и время в разных записях. order: 'dmy' или 'mdy' для вида 01/02/2026. */
export function parseDT(s, order = 'dmy') {
  s = String(s ?? '').trim();
  if (!s) return null;
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  }
  let y, mo, d, hh, mi, ss;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    [, y, mo, d, hh, mi, ss] = m;
  } else {
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    y = Number(m[3]);
    if (y < 100) y += 2000;
    if (order === 'mdy') {
      mo = m[1];
      d = m[2];
    } else {
      d = m[1];
      mo = m[2];
    }
    hh = m[4];
    mi = m[5];
    ss = m[6];
  }
  hh = Number(hh || 0);
  if (/pm/i.test(s) && hh < 12) hh += 12;
  if (/am/i.test(s) && hh === 12) hh = 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = new Date(Number(y), Number(mo) - 1, Number(d), hh, Number(mi || 0), Number(ss || 0)).getTime();
  return isNaN(t) ? null : t;
}

export function guessOrder(samples) {
  let dmy = false;
  let mdy = false;
  for (const s of samples) {
    const m = String(s).trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/);
    if (!m) continue;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  return mdy && !dmy ? 'mdy' : 'dmy';
}

function parseDuration(s) {
  const m = String(s || '').trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0)) * 1000;
}

export class ImportError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

// ---------- CareLink ----------

/** Разбирает CSV-выгрузку CareLink. Возвращает суточные итоги помпы и сахара сенсора, если они есть. */
export function parseCareLink(text) {
  const rows = parseCSV(text);
  const sections = [];
  let cur = null;
  for (const row of rows) {
    const cells = row.map((c) => c.trim());
    if (cells.includes('Index') && cells.includes('Date') && cells.includes('Time')) {
      cur = { head: cells, rows: [] };
      sections.push(cur);
    } else if (cur) {
      if (cells.length < 4 || /^-{3,}/.test(cells[0])) cur = null;
      else cur.rows.push(cells);
    }
  }
  if (!sections.length) {
    const firstLines = rows.slice(0, 12).map((r) => r.join(' | ').slice(0, 160));
    throw new ImportError('В файле не нашлась таблица CareLink: нет строки заголовков с колонками Index, Date и Time.', firstLines);
  }

  const boluses = [];
  const carbs = [];
  const changes = [];
  const glucose = [];
  const rewinds = [];
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const sec of sections) {
    const col = (re) => sec.head.findIndex((hname) => re.test(hname));
    const cDate = col(/^Date$/);
    const cTime = col(/^Time$/);
    const cBolus = col(/^Bolus Volume Delivered/i);
    const cCarb = col(/^BWZ Carb Input/i);
    const cBasal = col(/^Basal Rate/i);
    const cTempAmt = col(/^Temp Basal Amount/i);
    const cTempType = col(/^Temp Basal Type/i);
    const cTempDur = col(/^Temp Basal Duration/i);
    const cSuspend = col(/^Suspend$/i);
    const cRewind = col(/^Rewind$/i);
    const cSg = col(/^Sensor Glucose/i);
    const sgMg = cSg >= 0 && /mg\/dL/i.test(sec.head[cSg]);
    const order = guessOrder(sec.rows.slice(0, 400).map((r) => r[cDate]));

    for (const r of sec.rows) {
      const ts = parseDT(`${r[cDate]} ${r[cTime]}`, order);
      if (ts == null) continue;
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;

      const bolus = cBolus >= 0 ? num(r[cBolus]) : null;
      if (bolus != null && bolus > 0) boluses.push({ ts, units: bolus });

      const carb = cCarb >= 0 ? num(r[cCarb]) : null;
      if (carb != null && carb > 0) carbs.push({ ts, g: carb });

      const rate = cBasal >= 0 ? num(r[cBasal]) : null;
      if (rate != null) changes.push({ ts, type: 'rate', rate });

      const tempAmt = cTempAmt >= 0 ? num(r[cTempAmt]) : null;
      if (tempAmt != null) {
        const dur = cTempDur >= 0 ? parseDuration(r[cTempDur]) : null;
        if (dur) changes.push({ ts, type: 'temp', mode: /percent/i.test(r[cTempType] || '') ? 'pct' : 'abs', amount: tempAmt, until: ts + dur });
      }

      const susp = cSuspend >= 0 ? (r[cSuspend] || '').trim() : '';
      if (susp) changes.push({ ts, type: /NORMAL|RESUME/i.test(susp) ? 'resume' : 'suspend' });

      if (cRewind >= 0 && (r[cRewind] || '').trim()) rewinds.push(ts);

      const sg = cSg >= 0 ? num(r[cSg]) : null;
      if (sg != null && sg > 0) glucose.push([ts, round1(sgMg ? sg / MGDL : sg)]);
    }
  }

  if (!isFinite(minTs)) throw new ImportError('Таблица CareLink найдена, но в ней не удалось прочитать ни одной даты.', sections[0].rows.slice(0, 5).map((r) => r.slice(0, 4).join(' | ')));

  const basalByDay = integrateBasal(changes, maxTs);
  const firstFull = startOfDay(minTs) === minTs ? minTs : startOfDay(minTs) + DAY;
  const lastFullEnd = startOfDay(maxTs);

  const days = {};
  const day = (ts) => (days[ymd(ts)] ||= { bolus: 0, basal: null, carbs: 0, boluses: 0 });
  for (const b of boluses) {
    const d = day(b.ts);
    d.bolus += b.units;
    d.boluses++;
  }
  for (const c of carbs) day(c.ts).carbs += c.g;
  for (const [date, units] of Object.entries(basalByDay)) (days[date] ||= { bolus: 0, basal: null, carbs: 0, boluses: 0 }).basal = units;

  // Неполные первый и последний день исказили бы средние: убираем их.
  for (const date of Object.keys(days)) {
    const t = startOfDay(new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getTime());
    if (t < firstFull || t >= lastFullEnd) delete days[date];
    else {
      days[date].bolus = Math.round(days[date].bolus * 100) / 100;
      if (days[date].basal != null) days[date].basal = Math.round(days[date].basal * 100) / 100;
    }
  }

  glucose.sort((a, b) => a[0] - b[0]);
  return {
    days,
    glucose,
    rewinds,
    from: minTs,
    to: maxTs,
    counts: { boluses: boluses.length, carbs: carbs.length, basalChanges: changes.filter((c) => c.type === 'rate').length, days: Object.keys(days).length },
  };
}

/** Интегрирует базальную подачу по событиям: смена скорости, временная базальная, остановка. */
export function integrateBasal(changes, endTs) {
  const points = [];
  for (const c of changes) {
    points.push(c);
    if (c.type === 'temp') points.push({ ts: c.until, type: 'tempEnd' });
  }
  points.sort((a, b) => a.ts - b.ts);
  const perDay = {};
  let rate = null;
  let temp = null;
  let suspended = false;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.type === 'rate') rate = p.rate;
    else if (p.type === 'temp') temp = p;
    else if (p.type === 'tempEnd') {
      if (temp && temp.until <= p.ts) temp = null;
    } else if (p.type === 'suspend') suspended = true;
    else if (p.type === 'resume') suspended = false;

    const segEnd = i + 1 < points.length ? points[i + 1].ts : endTs;
    if (rate == null || segEnd <= p.ts) continue;
    const eff = suspended ? 0 : temp ? (temp.mode === 'pct' ? (rate * temp.amount) / 100 : temp.amount) : rate;
    let t = p.ts;
    while (t < segEnd) {
      const chunkEnd = Math.min(startOfDay(t) + DAY, segEnd);
      const key = ymd(t);
      perDay[key] = (perDay[key] || 0) + (eff * (chunkEnd - t)) / 3600000;
      t = chunkEnd;
    }
  }
  return perDay;
}

// ---------- Произвольная таблица с сахарами ----------

/** Читает таблицу и предлагает, какие колонки считать временем и значением. */
export function readTable(text) {
  const rows = parseCSV(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) throw new ImportError('В файле меньше двух строк: нечего импортировать.');
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length));

  // Строка заголовков: последняя строка в начале файла, после которой идут данные с датой.
  const hasDate = (r) => r.some((c) => parseDT(c) != null && /\d[-/.]\d/.test(c));
  let headIdx = -1;
  for (let i = 0; i < Math.min(rows.length - 1, 30); i++) {
    if (!hasDate(rows[i]) && hasDate(rows[i + 1])) headIdx = i;
    if (hasDate(rows[i])) break;
  }
  const body = rows.slice(headIdx + 1);
  const headers = Array.from({ length: width }, (_, i) => (headIdx >= 0 && rows[headIdx][i]?.trim()) || `Колонка ${i + 1}`);
  const sample = body.slice(0, 200);

  const score = (i, test) => sample.reduce((s, r) => s + (test(r[i] ?? '') ? 1 : 0), 0);
  const dateScores = headers.map((_, i) => score(i, (c) => /\d[-/.]\d/.test(c) && parseDT(c) != null));
  const dateCol = dateScores.indexOf(Math.max(...dateScores));
  const dateHasTime = score(dateCol, (c) => /\d:\d{2}/.test(c)) > sample.length / 2;
  let timeCol = -1;
  if (!dateHasTime) {
    const timeScores = headers.map((_, i) => (i === dateCol ? 0 : score(i, (c) => /^\s*\d{1,2}:\d{2}/.test(c))));
    const best = Math.max(...timeScores);
    if (best > sample.length / 2) timeCol = timeScores.indexOf(best);
  }

  const valueScores = headers.map((_, i) => {
    if (i === dateCol || i === timeCol) return 0;
    return score(i, (c) => {
      const v = num(c);
      return v != null && v >= 1 && v <= 600;
    });
  });
  const valueCol = valueScores.indexOf(Math.max(...valueScores));
  const values = sample.map((r) => num(r[valueCol])).filter((v) => v != null).sort((a, b) => a - b);
  const median = values.length ? values[values.length >> 1] : 0;

  return { headers, rows: body, guess: { dateCol, timeCol, valueCol, unit: median > 35 ? 'mgdl' : 'mmol' } };
}

export function buildGlucose(table, { dateCol, timeCol, valueCol, unit }) {
  const order = guessOrder(table.rows.slice(0, 400).map((r) => r[dateCol]));
  const map = new Map();
  let skipped = 0;
  for (const r of table.rows) {
    const stamp = timeCol >= 0 ? `${r[dateCol]} ${r[timeCol]}` : r[dateCol];
    const ts = parseDT(stamp, order);
    let v = num(r[valueCol]);
    if (ts == null || v == null || v <= 0) {
      skipped++;
      continue;
    }
    if (unit === 'mgdl') v /= MGDL;
    if (v < 1 || v > 40) {
      skipped++;
      continue;
    }
    map.set(ts, round1(v));
  }
  const readings = [...map.entries()].sort((a, b) => a[0] - b[0]);
  return { readings, skipped };
}

export function mergeGlucose(existing, incoming) {
  const map = new Map(existing);
  for (const [ts, v] of incoming) map.set(ts, v);
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}
