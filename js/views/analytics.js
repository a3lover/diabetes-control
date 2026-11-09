import { data, commit, saveGlucose, savePump } from '../store.js';
import { h, icon, openSheet, toast, pickFile, fmtDate, fmtNum, plural, DAYS } from '../ui.js';
import { analyze, targets, pumpStats, DAY } from '../metrics.js';
import { parseCareLink, readTable, buildGlucose, mergeGlucose, ImportError } from '../importers.js';
import { fromYmd } from '../logic.js';

let period = 14;

const SEGMENTS = [
  ['vlow', 'Очень низко, ниже 3,0'],
  ['low', 'Низко, 3,0–3,8'],
  ['inr', 'В цели, 3,9–10,0'],
  ['high', 'Высоко, 10,1–13,9'],
  ['vhigh', 'Очень высоко, выше 13,9'],
];

export function tirBar(a, withLegend = true) {
  const pct = (p) => fmtNum(p, p > 0 && p < 10 ? 1 : 0) + '%';
  return h(
    'div',
    { class: 'tir' },
    h(
      'div',
      { class: 'tirbar', role: 'img', 'aria-label': SEGMENTS.map(([k, l]) => `${l}: ${pct(a.pct[k])}`).join('; ') },
      SEGMENTS.map(([k]) => a.pct[k] > 0 && h('span', { class: 'seg-' + k, style: { flex: String(a.pct[k]) } })),
    ),
    withLegend && h('ul', { class: 'legend' }, SEGMENTS.map(([k, l]) => h('li', {}, h('i', { class: 'seg-' + k }), h('span', {}, l), h('b', {}, pct(a.pct[k]))))),
  );
}

function agpChart(a) {
  const W = 720;
  const H = 250;
  const L = 34;
  const R = 8;
  const T = 10;
  const B = 24;
  const pts = a.agp.map((b, i) => (b ? { i, ...b } : null)).filter(Boolean);
  if (pts.length < 4) return h('p', { class: 'empty' }, 'Для суточного профиля пока мало данных.');
  const yMax = Math.min(22, Math.max(15, Math.ceil(Math.max(...pts.map((p) => p.p95)) + 1)));
  const yMin = 2;
  const x = (i) => L + ((i + 0.5) / 48) * (W - L - R);
  const y = (v) => T + (1 - (Math.min(yMax, Math.max(yMin, v)) - yMin) / (yMax - yMin)) * (H - T - B);
  const line = (k) => pts.map((p, n) => `${n ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
  const band = (lo, hi) => `${line(hi)}${[...pts].reverse().map((p) => `L${x(p.i).toFixed(1)},${y(p[lo]).toFixed(1)}`).join('')}Z`;
  const yTicks = [3.9, 10, 13.9].filter((v) => v < yMax);
  const xTicks = [0, 6, 12, 18, 24];
  const svg = `
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Суточный профиль: медиана и разброс сахара по времени суток">
  <rect x="${L}" y="${y(10)}" width="${W - L - R}" height="${y(3.9) - y(10)}" class="agp-target"/>
  ${yTicks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="agp-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="agp-label">${String(v).replace('.', ',')}</text>`).join('')}
  ${xTicks.map((hr) => `<text x="${L + (hr / 24) * (W - L - R)}" y="${H - 6}" text-anchor="${hr === 0 ? 'start' : hr === 24 ? 'end' : 'middle'}" class="agp-label">${String(hr).padStart(2, '0')}:00</text>`).join('')}
  <path d="${band('p5', 'p95')}" class="agp-outer"/>
  <path d="${band('p25', 'p75')}" class="agp-inner"/>
  <path d="${line('p50')}" class="agp-median"/>
</svg>`;
  return h(
    'div',
    {},
    h('div', { class: 'chart', html: svg }),
    h('ul', { class: 'legend inline' }, h('li', {}, h('i', { class: 'key-median' }), 'медиана'), h('li', {}, h('i', { class: 'key-inner' }), 'половина всех значений'), h('li', {}, h('i', { class: 'key-outer' }), '90% значений'), h('li', {}, h('i', { class: 'key-target' }), 'цель 3,9–10,0')),
  );
}

function dayBars(a) {
  return h(
    'div',
    { class: 'daybars', role: 'img', 'aria-label': 'Время в цели по дням' },
    a.days.map((d) => {
      const tirPct = (d.inr / d.n) * 100;
      return h(
        'div',
        { class: 'daybar', title: `${fmtDate(fromYmd(d.date))}: в цели ${fmtNum(tirPct)}%, средний ${fmtNum(d.sum / d.n, 1)}` },
        d.above > 0 && h('span', { class: 'seg-high', style: { flex: String(d.above) } }),
        d.inr > 0 && h('span', { class: 'seg-inr', style: { flex: String(d.inr) } }),
        d.below > 0 && h('span', { class: 'seg-low', style: { flex: String(d.below) } }),
      );
    }),
  );
}

const ZONE_TEXT = {
  A: 'Зона A: самый низкий риск. Сахара стабильны, гипо и высоких значений мало.',
  B: 'Зона B: низкий риск. Есть небольшой запас для улучшения.',
  C: 'Зона C: умеренный риск. Стоит обсудить с врачом, что тянет показатель вверх.',
  D: 'Зона D: высокий риск. Нужна корректировка терапии вместе с врачом.',
  E: 'Зона E: очень высокий риск. Обратитесь к врачу.',
};

function stat(label, value, hint) {
  return h('div', { class: 'stat' }, h('span', { class: 'muted' }, label), h('b', {}, value), hint && h('small', {}, hint));
}

// ---------- Импорт ----------

async function importGlucose() {
  const file = await pickFile('.csv,.tsv,.txt,text/csv,text/plain');
  if (!file) return;
  let table;
  try {
    table = readTable(file.text);
  } catch (e) {
    return showImportError(e);
  }
  const cols = table.headers.map((name, i) => [i, name]);
  const select = (id, options, value) => h('select', { id }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
  const sDate = select('i-date', cols, table.guess.dateCol);
  const sTime = select('i-time', [[-1, 'Время в той же колонке'], ...cols], table.guess.timeCol);
  const sValue = select('i-value', cols, table.guess.valueCol);
  const sUnit = select('i-unit', [['mmol', 'ммоль/л'], ['mgdl', 'мг/дл']], table.guess.unit);
  const preview = h('div', { class: 'preview' });
  const button = h('button', { class: 'btn primary wide', type: 'button' }, 'Импортировать');
  const mapping = () => ({ dateCol: Number(sDate.value), timeCol: Number(sTime.value), valueCol: Number(sValue.value), unit: sUnit.value });
  let built;
  const draw = () => {
    built = buildGlucose(table, mapping());
    const r = built.readings;
    button.disabled = !r.length;
    button.textContent = r.length ? `Импортировать ${fmtNum(r.length)} ${plural(r.length, ['значение', 'значения', 'значений'])}` : 'Нет подходящих строк';
    const fmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    preview.replaceChildren(
      r.length
        ? h('p', { class: 'hint' }, `Прочитано с ${fmtDate(r[0][0], true)} по ${fmtDate(r.at(-1)[0], true)}. Первые значения: ${r.slice(0, 3).map(([ts, v]) => `${fmt.format(ts)}: ${fmtNum(v, 1)}`).join('; ')}. Пропущено строк: ${built.skipped}.`)
        : h('p', { class: 'hint' }, 'С этими колонками не удалось прочитать ни одной строки. Выберите другие колонки.'),
    );
  };
  [sDate, sTime, sValue, sUnit].forEach((s) => (s.onchange = draw));
  draw();
  const field = (label, el) => h('div', { class: 'field' }, h('label', { for: el.id }, label), el);
  const close = openSheet(
    'Импорт сахаров',
    h('div', { class: 'form' }, h('p', { class: 'hint' }, `Файл «${file.name}». Проверьте, что колонки определены верно.`), field('Дата', sDate), field('Время', sTime), field('Значение сахара', sValue), field('Единицы', sUnit), preview, button),
  );
  button.onclick = async () => {
    data.glucose = mergeGlucose(data.glucose, built.readings);
    data.state.imports.glucose = { at: Date.now(), name: file.name };
    await saveGlucose();
    commit();
    close();
    toast(`Импортировано: ${fmtNum(built.readings.length)}`);
  };
}

async function importCareLink() {
  const file = await pickFile('.csv,text/csv,text/plain');
  if (!file) return;
  let res;
  try {
    res = parseCareLink(file.text);
  } catch (e) {
    return showImportError(e);
  }
  Object.assign(data.pump.days, res.days);
  data.state.imports.pump = { at: Date.now(), name: file.name };
  if (res.glucose.length) {
    data.glucose = mergeGlucose(data.glucose, res.glucose);
    await saveGlucose();
  }
  await savePump();
  commit();
  const c = res.counts;
  openSheet(
    'Выгрузка CareLink загружена',
    h(
      'div',
      { class: 'sheet-body' },
      h('p', {}, `Период с ${fmtDate(res.from, true)} по ${fmtDate(res.to, true)}. Полных дней: ${c.days}.`),
      h('div', { class: 'rows compact' }, h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Болюсов'), h('b', {}, fmtNum(c.boluses))), h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Записей об углеводах'), h('b', {}, fmtNum(c.carbs))), h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Изменений базальной скорости'), h('b', {}, fmtNum(c.basalChanges))), h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Значений сенсора'), h('b', {}, fmtNum(res.glucose.length)))),
      !c.basalChanges && h('p', { class: 'hint' }, 'В файле нет записей о базальной скорости, поэтому суточная доза посчитана только по болюсам.'),
      h('p', { class: 'hint' }, 'Сверьте среднюю суточную дозу с отчётом CareLink. Разбор файла написан по описанию формата и ещё не проверен на выгрузке вашей помпы.'),
    ),
  );
}

function showImportError(e) {
  console.error(e);
  openSheet(
    'Файл не прочитан',
    h('div', { class: 'sheet-body' }, h('p', {}, e instanceof ImportError ? e.message : `Ошибка при разборе файла: ${e.message}`), e.details?.length > 0 && h('div', {}, h('p', { class: 'hint' }, 'Начало файла, как его видит приложение:'), h('pre', { class: 'pre' }, e.details.join('\n')))),
  );
}

async function clearReadings() {
  if (!confirm('Удалить все загруженные сахара и данные помпы? Запасы и врачи останутся.')) return;
  data.glucose = [];
  data.pump = { days: {} };
  data.state.imports = { glucose: null, pump: null };
  await Promise.all([saveGlucose(), savePump()]);
  commit();
}

// ---------- Экран ----------

export function analytics() {
  const { glucose, pump, state } = data;
  const importButtons = h(
    'div',
    { class: 'actions no-print' },
    h('button', { class: 'btn primary', type: 'button', onclick: importGlucose }, 'Загрузить сахара'),
    h('button', { class: 'btn', type: 'button', onclick: importCareLink }, 'Загрузить выгрузку CareLink'),
  );
  const head = (extra) => h('header', { class: 'page-head with-action' }, h('div', {}, h('h1', {}, 'Компенсация'), h('p', { class: 'lead' }, 'Насколько ровно идут сахара и что с инсулином.')), extra);

  const pumpDates = Object.keys(pump.days || {}).sort();
  if (!glucose.length && !pumpDates.length) {
    return h(
      'div',
      { class: 'page' },
      head(),
      h(
        'section',
        { class: 'card glass' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Данных пока нет')),
        h('p', {}, 'Загрузите файл с сахарами из приложения датчика и выгрузку из CareLink. Приложение посчитает время в цели, индекс риска, суточный профиль и расход инсулина.'),
        h(
          'ul',
          { class: 'steps' },
          h('li', {}, h('b', {}, 'Сахара. '), 'Подойдёт любая таблица CSV, где есть дата со временем и значение. Колонки можно выбрать вручную.'),
          h('li', {}, h('b', {}, 'Помпа. '), 'На сайте CareLink откройте «Отчёты», выберите период и нажмите «Экспорт данных (CSV)».'),
        ),
        importButtons,
      ),
    );
  }

  const to = glucose.length ? glucose.at(-1)[0] + 1 : fromYmd(pumpDates.at(-1)) + DAY;
  const from = to - period * DAY;
  const a = analyze(glucose, from, to);
  const p = pumpStats(pump, from, to);

  const seg = h(
    'div',
    { class: 'seg no-print', role: 'group', 'aria-label': 'Период' },
    [7, 14, 30, 90].map((n) =>
      h('button', { type: 'button', 'aria-pressed': String(period === n), onclick: () => ((period = n), commit()) }, `${n} ${plural(n, DAYS)}`),
    ),
  );

  const sugarCards = a
    ? [
        h(
          'section',
          { class: 'card glass span-2 gri', 'data-zone': a.zone },
          h('div', { class: 'card-head' }, h('h2', {}, 'Индекс гликемического риска')),
          h('div', { class: 'gri-row' }, h('div', { class: 'gri-num' }, h('b', {}, fmtNum(a.gri)), h('span', {}, 'из 100')), h('div', {}, h('p', {}, ZONE_TEXT[a.zone]), h('p', { class: 'hint' }, 'GRI объединяет долю низких и высоких сахаров в одно число: чем меньше, тем лучше. Низкие значения весят больше высоких.'))),
          h('div', { class: 'gri-scale', 'aria-hidden': 'true' }, h('i', { style: { left: `${a.gri}%` } })),
        ),
        h(
          'section',
          { class: 'card glass' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Время в диапазонах')),
          tirBar(a),
          h('div', { class: 'stats' }, stat('Средний сахар', fmtNum(a.mean, 1), 'ммоль/л'), stat('GMI', fmtNum(a.gmi, 1) + '%', 'расчётный HbA1c'), stat('Вариабельность', fmtNum(a.cv) + '%', 'CV'), stat('Эпизоды гипо', fmtNum(a.hypoEpisodes), 'ниже 3,9 от 15 минут')),
          a.coverage < 0.7 && h('p', { class: 'hint warn-text' }, `Данные покрывают только ${fmtNum(a.coverage * 100)}% периода. Показатели считаются надёжными при покрытии от 70%.`),
        ),
        h(
          'section',
          { class: 'card glass' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Цели')),
          h(
            'div',
            { class: 'rows compact' },
            targets(a).map((t) => h('div', { class: 'row' }, h('span', { class: 'mark ' + (t.ok ? 'ok' : 'danger') }, icon(t.ok ? 'check' : 'miss', 16)), h('div', { class: 'row-main' }, h('b', {}, t.label), h('span', { class: 'muted' }, `цель ${t.goal}`)), h('b', { class: 'num' }, fmtNum(t.value, t.value < 10 ? 1 : 0) + '%'))),
          ),
          h('p', { class: 'hint' }, 'Цели международного консенсуса для взрослых с диабетом 1 типа. Ваши личные цели может изменить врач.'),
        ),
        h('section', { class: 'card glass span-2' }, h('div', { class: 'card-head' }, h('h2', {}, 'Суточный профиль')), agpChart(a)),
        h('section', { class: 'card glass span-2' }, h('div', { class: 'card-head' }, h('h2', {}, 'По дням')), dayBars(a), h('ul', { class: 'legend inline' }, h('li', {}, h('i', { class: 'seg-high' }), 'выше 10,0'), h('li', {}, h('i', { class: 'seg-inr' }), 'в цели'), h('li', {}, h('i', { class: 'seg-low' }), 'ниже 3,9'))),
      ]
    : [h('section', { class: 'card glass span-2' }, h('p', { class: 'empty' }, glucose.length ? 'За выбранный период сахаров нет. Выберите период длиннее или загрузите свежий файл.' : 'Сахара ещё не загружены.'))];

  const insulinCard =
    p &&
    h(
      'section',
      { class: 'card glass span-2' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Инсулин и еда'), h('span', { class: 'muted' }, `в среднем за ${p.days} ${plural(p.days, DAYS)}`)),
      h(
        'div',
        { class: 'stats' },
        stat('Суточная доза', p.tdd == null ? '–' : fmtNum(p.tdd, 1), 'ед'),
        stat('База', p.basal == null ? '–' : fmtNum(p.basal, 1), p.tdd ? `ед, ${fmtNum((p.basal / p.tdd) * 100)}%` : 'ед'),
        stat('Болюсы', fmtNum(p.bolus, 1), p.tdd ? `ед, ${fmtNum((p.bolus / p.tdd) * 100)}%` : 'ед'),
        stat('Углеводы', fmtNum(p.carbs), 'г в сутки'),
        stat('Болюсов', fmtNum(p.boluses, 1), 'в сутки'),
      ),
      p.tdd != null &&
        state.supplies.insulin.configured &&
        Math.abs(p.tdd - state.supplies.insulin.dailyUnits) > 1 &&
        h('p', { class: 'hint' }, `В прогнозе запаса сейчас стоит расход ${fmtNum(state.supplies.insulin.dailyUnits, 1)} ед в сутки. Помпа показывает ${fmtNum(p.tdd, 1)} ед без потерь на заполнение. При необходимости поправьте расход на вкладке «Запасы».`),
    );

  const src = state.imports;
  return h(
    'div',
    { class: 'page' },
    head(seg),
    h('p', { class: 'period' }, `Период с ${fmtDate(from, true)} по ${fmtDate(to - 1, true)}`),
    h('div', { class: 'grid-2' }, sugarCards, insulinCard),
    h(
      'section',
      { class: 'card glass no-print' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Данные')),
      h('p', { class: 'muted' }, [glucose.length ? `Сахара: ${fmtNum(glucose.length)} ${plural(glucose.length, ['значение', 'значения', 'значений'])}, с ${fmtDate(glucose[0][0], true)} по ${fmtDate(glucose.at(-1)[0], true)}.` : 'Сахара не загружены.', pumpDates.length ? `Помпа: ${pumpDates.length} ${plural(pumpDates.length, DAYS)}, по ${fmtDate(fromYmd(pumpDates.at(-1)), true)}.` : 'Данные помпы не загружены.', src.glucose ? `Последний файл сахаров: ${src.glucose.name}.` : ''].join(' ')),
      importButtons,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Распечатать отчёт для врача'), h('button', { class: 'btn danger-text', type: 'button', onclick: clearReadings }, 'Удалить сахара и данные помпы')),
    ),
  );
}
