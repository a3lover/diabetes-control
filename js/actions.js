// Шторки с действиями: отметить смену, пополнить запас, настроить расходник, собрать в поездку.

import { data, commit, logEvent } from './store.js';
import { h, form, openSheet, toast, dtLocal, fmtNum, plural, DAYS } from './ui.js';
import { dayDiff, travelNeeds, insulinInfo } from './logic.js';
import { pumpStats } from './metrics.js';

export const SITES = ['Живот слева', 'Живот справа', 'Бедро левое', 'Бедро правое', 'Ягодица левая', 'Ягодица правая', 'Плечо левое', 'Плечо правое'];

export const SUPPLY_TITLES = { insulin: 'Инсулин', sets: 'Инфузионные наборы', reservoirs: 'Резервуары', sensors: 'Датчики' };

function siteOptions() {
  const now = Date.now();
  const lastUse = {};
  for (const e of data.state.events) if (e.type === 'set' && e.site) lastUse[e.site] = Math.max(lastUse[e.site] || 0, e.at);
  return SITES.map((s) => {
    if (!lastUse[s]) return [s, s, 'ещё не было'];
    const d = dayDiff(now, lastUse[s]);
    return [s, s, d === 0 ? 'сегодня' : `${d} ${plural(d, DAYS)} назад`];
  });
}

export function sheetSetChange() {
  const R = data.state.supplies.reservoirs;
  const close = openSheet(
    'Смена инфузионного набора',
    form(
      [
        { name: 'at', label: 'Когда', type: 'datetime-local', value: dtLocal(Date.now()), required: true },
        { name: 'site', label: 'Куда поставили', type: 'chips', options: siteOptions(), hint: 'Необязательно. Помогает чередовать места.' },
        { name: 'withReservoir', label: 'Заодно заправил новый резервуар', type: 'checkbox', value: R.mode === 'withSet' },
        { name: 'units', label: 'Сколько единиц набрали в резервуар', type: 'number', min: 1, max: 300, value: R.fillUnits, hint: 'Нужно, только если заправляли резервуар.' },
      ],
      'Записать смену',
      (v, f) => {
        if (v.withReservoir && !v.units) {
          f.elements.units.focus();
          return toast('Укажите, сколько единиц набрали в резервуар');
        }
        const at = new Date(v.at).getTime();
        logEvent({ type: 'set', at, site: v.site || null });
        if (v.withReservoir) logEvent({ type: 'reservoir', at, units: v.units });
        close();
        toast('Смена набора записана');
      },
    ),
  );
}

export function sheetReservoir() {
  const R = data.state.supplies.reservoirs;
  const close = openSheet(
    'Заправка резервуара',
    form(
      [
        { name: 'at', label: 'Когда', type: 'datetime-local', value: dtLocal(Date.now()), required: true },
        { name: 'units', label: 'Сколько единиц набрали', type: 'number', min: 1, max: 300, value: R.fillUnits, required: true, hint: 'Это количество спишется из запаса инсулина.' },
      ],
      'Записать заправку',
      (v) => {
        logEvent({ type: 'reservoir', at: new Date(v.at).getTime(), units: v.units });
        close();
        toast('Заправка записана');
      },
    ),
  );
}

export function sheetSensor() {
  const close = openSheet(
    'Новый датчик',
    form([{ name: 'at', label: 'Когда поставили', type: 'datetime-local', value: dtLocal(Date.now()), required: true }], 'Записать датчик', (v) => {
      logEvent({ type: 'sensor', at: new Date(v.at).getTime() });
      close();
      toast('Датчик записан');
    }),
  );
}

export function sheetRestock(kind) {
  const s = data.state.supplies[kind];
  const label = kind === 'insulin' ? `Сколько упаковок по ${s.packUnits} ед добавить` : 'Сколько штук добавить';
  const close = openSheet(
    `Пополнить: ${SUPPLY_TITLES[kind].toLowerCase()}`,
    form([{ name: 'qty', label, type: 'number', min: 1, step: 1, required: true }], 'Добавить в запас', (v) => {
      logEvent({ type: 'restock', at: Date.now(), item: kind, qty: v.qty });
      close();
      toast('Запас пополнен');
    }),
  );
}

export function sheetEditSupply(kind) {
  const s = data.state.supplies[kind];
  const reserve = { name: 'reserveDays', label: 'За сколько дней до конца запаса напоминать', type: 'number', min: 0, step: 1, value: s.reserveDays, required: true, hint: 'Заложите время на рецепт, заказ и доставку.' };
  let fields;
  if (kind === 'insulin') {
    const p = pumpStats(data.pump, Date.now() - 14 * 864e5, Date.now());
    const fromPump = p?.tdd ? ` По данным помпы за последние дни: ${fmtNum(p.tdd, 1)} ед в сутки, без учёта заполнения канюли.` : '';
    fields = [
      { name: 'name', label: 'Название', value: s.name, required: true },
      { name: 'packUnits', label: 'Одна упаковка', type: 'select', value: s.packUnits, options: [[300, 'Картридж или шприц-ручка 3 мл, 300 ед'], [1000, 'Флакон 10 мл, 1000 ед']] },
      { name: 'fullPacks', label: 'Целых упаковок в запасе', type: 'number', min: 0, step: 1, value: s.fullPacks, required: true },
      { name: 'openedUnits', label: 'Осталось в начатой, ед', type: 'number', min: 0, value: s.openedUnits, required: true },
      { name: 'dailyUnits', label: 'Средний расход в сутки, ед', type: 'number', min: 1, value: s.dailyUnits, required: true, hint: 'Вместе с базой, болюсами и потерями на заполнение. По нему считается прогноз.' + fromPump },
      reserve,
    ];
  } else if (kind === 'sets') {
    fields = [
      { name: 'name', label: 'Название', value: s.name, required: true },
      { name: 'stock', label: 'Штук в запасе', type: 'number', min: 0, step: 1, value: s.stock, required: true },
      { name: 'intervalDays', label: 'Менять каждые, дней', type: 'number', min: 1, max: 7, value: s.intervalDays, required: true },
      reserve,
    ];
  } else if (kind === 'reservoirs') {
    fields = [
      { name: 'name', label: 'Название', value: s.name, required: true },
      { name: 'stock', label: 'Штук в запасе', type: 'number', min: 0, step: 1, value: s.stock, required: true },
      { name: 'mode', label: 'Когда меняете резервуар', type: 'select', value: s.mode, options: [['withSet', 'Вместе с инфузионным набором'], ['whenEmpty', 'Когда закончится инсулин']] },
      { name: 'fillUnits', label: 'Обычно набираю, ед', type: 'number', min: 1, max: 300, value: s.fillUnits, hint: 'Подставляется при записи заправки.' },
      reserve,
    ];
  } else {
    fields = [
      { name: 'name', label: 'Название', value: s.name, required: true },
      { name: 'stock', label: 'Штук в запасе', type: 'number', min: 0, step: 1, value: s.stock, required: true },
      { name: 'wearDays', label: 'Срок работы одного датчика, дней', type: 'number', min: 1, max: 30, value: s.wearDays, required: true, hint: 'Сверьте с упаковкой вашего датчика.' },
      reserve,
    ];
  }
  const close = openSheet(
    SUPPLY_TITLES[kind],
    form(fields, 'Сохранить', (v) => {
      if (v.packUnits != null) v.packUnits = Number(v.packUnits);
      Object.assign(s, v, { configured: true });
      commit();
      close();
      toast('Сохранено');
    }),
  );
}

export function sheetTravel() {
  const S = data.state.supplies;
  const result = h('div', { class: 'rows compact' });
  const daysInput = h('input', { id: 't-days', type: 'number', min: 1, step: 1, value: 7, inputmode: 'numeric' });
  const reserveInput = h('input', { id: 't-res', type: 'number', min: 0, step: 10, value: 100, inputmode: 'numeric' });
  const draw = () => {
    const days = Number(daysInput.value) || 0;
    const need = travelNeeds(data.state, days, Number(reserveInput.value) || 0);
    const have = { insulin: insulinInfo(data.state, Date.now()).home, sets: S.sets.stock, reservoirs: S.reservoirs.stock, sensors: S.sensors.stock };
    const unit = { insulin: 'ед', sets: 'шт', reservoirs: 'шт', sensors: 'шт' };
    result.replaceChildren(
      ...Object.keys(need).map((k) => {
        const n = need[k];
        const enough = n != null && have[k] >= n;
        return h(
          'div',
          { class: 'row' },
          h('div', { class: 'row-main' }, h('b', {}, SUPPLY_TITLES[k]), h('span', { class: 'muted' }, n == null ? 'не настроено' : `в запасе ${fmtNum(have[k])} ${unit[k]}`)),
          n != null && h('span', { class: 'pill ' + (enough ? 'ok' : 'danger') }, `взять ${fmtNum(n)} ${unit[k]}`),
        );
      }),
    );
  };
  daysInput.oninput = reserveInput.oninput = draw;
  draw();
  openSheet(
    'Собрать в поездку',
    h(
      'div',
      { class: 'form' },
      h('div', { class: 'field-row' }, h('div', { class: 'field' }, h('label', { for: 't-days' }, 'Дней в поездке'), daysInput), h('div', { class: 'field' }, h('label', { for: 't-res' }, 'Запас сверху, %'), reserveInput)),
      h('p', { class: 'hint' }, 'Запас 100% означает двойное количество: на случай задержки, потери багажа или отказа набора.'),
      result,
    ),
  );
}
