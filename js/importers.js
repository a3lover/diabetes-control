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

export class ImportError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

// ---------- CareLink ----------
//
// Формат проверен на выгрузке MiniMed 720G. Что важно знать о нём:
// - строки идут от новых к старым;
// - болюс записан двумя строками: «выбрано» и «введено», берём введённое;
// - колонка Basal Rate смешивает два вида строк. Фактическая скорость пишется в момент события
//   (старт и конец временной базальной, остановка, возобновление, граница профиля).
//   Плановая скорость профиля пишется второй строкой на границе и одиночной строкой
//   в начале следующей минуты после события. Для расчёта нужна только фактическая;
// - углеводы могут быть в хлебных единицах (exchanges), а не в граммах.

/** Разбирает CSV-выгрузку CareLink: суточные итоги, заправки резервуара, сахара сенсора. */
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
  const rateRows = [];
  const suspends = [];
  const primes = [];
  const fills = [];
  const glucose = [];
  const rewinds = [];
  let carbUnit = 'g';
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const sec of sections) {
    const col = (re) => sec.head.findIndex((hname) => re.test(hname));
    const cDate = col(/^Date$/);
    const cTime = col(/^Time$/);
    const cBolus = col(/^Bolus Volume Delivered/i);
    const cCarb = col(/^BWZ Carb Input/i);
    const cBasal = col(/^Basal Rate/i);
    const cSuspend = col(/^Suspend$/i);
    const cRewind = col(/^Rewind$/i);
    const cPrimeType = col(/^Prime Type/i);
    const cPrimeVol = col(/^Prime Volume Delivered/i);
    const cFillVol = col(/^Estimated Reservoir Volume after Fill/i);
    const cSg = col(/^Sensor Glucose/i);
    const sgMg = cSg >= 0 && /mg\/dL/i.test(sec.head[cSg]);
    if (cCarb >= 0 && /exchange/i.test(sec.head[cCarb])) carbUnit = 'ex';
    const order = guessOrder(sec.rows.slice(0, 400).map((r) => r[cDate]));

    const parsed = [];
    for (const r of sec.rows) {
      const ts = parseDT(`${r[cDate]} ${r[cTime]}`, order);
      if (ts != null) parsed.push({ ts, r });
    }
    if (!parsed.length) continue;
    // Порядок внутри одной секунды: в файле «от новых к старым» более ранняя строка стоит ниже.
    const newestFirst = parsed[0].ts > parsed[parsed.length - 1].ts;

    parsed.forEach(({ ts, r }, i) => {
      const ord = newestFirst ? -i : i;
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;

      const bolus = cBolus >= 0 ? num(r[cBolus]) : null;
      if (bolus != null && bolus > 0) boluses.push({ ts, units: bolus });

      const carb = cCarb >= 0 ? num(r[cCarb]) : null;
      if (carb != null && carb > 0) carbs.push({ ts, amount: carb });

      const rate = cBasal >= 0 ? num(r[cBasal]) : null;
      if (rate != null) rateRows.push({ ts, ord, rate });

      const susp = cSuspend >= 0 ? (r[cSuspend] || '').trim() : '';
      if (susp) suspends.push({ ts, ord, type: /NORMAL|RESUME/i.test(susp) ? 'resume' : 'suspend' });

      if (cRewind >= 0 && (r[cRewind] || '').trim()) rewinds.push(ts);

      const primeType = cPrimeType >= 0 ? (r[cPrimeType] || '').trim() : '';
      if (primeType) {
        const vol = (cPrimeVol >= 0 ? num(r[cPrimeVol]) : null) || 0;
        const kind = /cannula/i.test(primeType) ? 'cannula' : 'tubing';
        if (vol > 0) primes.push({ ts, units: vol, kind });
        if (kind === 'tubing') fills.push({ ts, volume: cFillVol >= 0 ? num(r[cFillVol]) : null, prime: vol, cannula: 0 });
        else fills.push({ ts, cannulaOnly: true, units: vol });
      }

      const sg = cSg >= 0 ? num(r[cSg]) : null;
      if (sg != null && sg > 0) glucose.push([ts, round1(sgMg ? sg / MGDL : sg)]);
    });
  }

  if (!isFinite(minTs)) throw new ImportError('Таблица CareLink найдена, но в ней не удалось прочитать ни одной даты.', sections[0].rows.slice(0, 5).map((r) => r.slice(0, 4).join(' | ')));

  const byTime = (a, b) => a.ts - b.ts || a.ord - b.ord;
  rateRows.sort(byTime);
  suspends.sort(byTime);
  const changes = [...effectiveBasal(rateRows), ...suspends].sort(byTime);
  const basalByDay = integrateBasal(changes, maxTs);

  // Заправки: заполнение трубки открывает новую, заполнение канюли в ближайшие 15 минут относится к ней же.
  const reservoirFills = [];
  for (const f of fills.sort((a, b) => a.ts - b.ts)) {
    if (!f.cannulaOnly) reservoirFills.push({ ts: f.ts, volume: f.volume, prime: f.prime, cannula: 0 });
    else {
      const last = reservoirFills[reservoirFills.length - 1];
      if (last && f.ts - last.ts <= 15 * 60000) last.cannula += f.units;
    }
  }

  const firstRate = rateRows.length ? rateRows[0].ts : minTs;
  const firstFull = startOfDay(firstRate) === firstRate ? firstRate : startOfDay(firstRate) + DAY;
  const lastFullEnd = startOfDay(maxTs);

  const days = {};
  const day = (ts) => (days[ymd(ts)] ||= { bolus: 0, basal: null, carbs: 0, boluses: 0, prime: 0 });
  for (const b of boluses) {
    const d = day(b.ts);
    d.bolus += b.units;
    d.boluses++;
  }
  for (const c of carbs) day(c.ts).carbs += c.amount;
  for (const p of primes) day(p.ts).prime += p.units;
  for (const [date, units] of Object.entries(basalByDay)) (days[date] ||= { bolus: 0, basal: null, carbs: 0, boluses: 0, prime: 0 }).basal = units;

  // Неполные первый и последний день исказили бы средние: убираем их.
  const r2 = (x) => Math.round(x * 100) / 100;
  for (const date of Object.keys(days)) {
    const t = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getTime();
    if (t < firstFull || t >= lastFullEnd) delete days[date];
    else {
      const d = days[date];
      d.bolus = r2(d.bolus);
      d.carbs = r2(d.carbs);
      d.prime = r2(d.prime);
      if (d.basal != null) d.basal = r2(d.basal);
    }
  }

  glucose.sort((a, b) => a[0] - b[0]);
  return {
    days,
    carbUnit,
    glucose,
    rewinds,
    fills: reservoirFills,
    from: minTs,
    to: maxTs,
    counts: { boluses: boluses.length, carbs: carbs.length, basalChanges: changes.filter((c) => c.type === 'rate').length, days: Object.keys(days).length },
  };
}

/**
 * Оставляет из строк Basal Rate только фактическую скорость подачи.
 * rows: [{ ts, ord, rate }] в хронологическом порядке.
 */
export function effectiveBasal(rows) {
  const out = [];
  let current = null;
  let prevTs = null;
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && rows[j].ts === rows[i].ts) j++;
    const first = rows[i];
    const single = j - i === 1;
    const d = new Date(first.ts);
    const wholeMinute = d.getSeconds() === 0;
    const onGrid = wholeMinute && d.getMinutes() % 30 === 0;
    // Плановая скорость, записанная в начале следующей минуты после события.
    const echo = single && wholeMinute && prevTs != null && first.ts - prevTs < 60000;
    // Плановая скорость на границе профиля, пока подача остановлена.
    const scheduledWhileStopped = single && onGrid && current === 0;
    if (!echo && !scheduledWhileStopped) {
      out.push({ ts: first.ts, ord: first.ord, type: 'rate', rate: first.rate });
      current = first.rate;
      prevTs = first.ts;
    }
    i = j;
  }
  return out;
}

/** Считает базальный инсулин по дням. changes: 'rate' | 'suspend' | 'resume' в хронологическом порядке. */
export function integrateBasal(changes, endTs) {
  const perDay = {};
  let rate = null;
  let suspended = false;
  for (let i = 0; i < changes.length; i++) {
    const p = changes[i];
    if (p.type === 'rate') rate = p.rate;
    else if (p.type === 'suspend') suspended = true;
    else if (p.type === 'resume') suspended = false;

    const segEnd = i + 1 < changes.length ? changes[i + 1].ts : endTs;
    if (rate == null || segEnd <= p.ts) continue;
    const eff = suspended ? 0 : rate;
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
