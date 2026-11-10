import { data, removeEvent } from '../store.js';
import { h, icon, fmtDate, fmtNum, plural, DAYS } from '../ui.js';
import { insulinInfo, stockInfo, statusByDays } from '../logic.js';
import { sheetRestock, sheetEditSupply, sheetTravel, SUPPLY_TITLES } from '../actions.js';

function supplyCard(kind, now) {
  const state = data.state;
  const s = state.supplies[kind];
  // Заголовок у всех карточек одинаковый: вид расходника, под ним название, справа срок.
  const head = (pill) => h('div', { class: 'card-head nowrap' }, h('div', { class: 'title-block' }, h('h2', {}, SUPPLY_TITLES[kind]), h('p', { class: 'muted one-line' }, s.name)), pill);

  if (!s.configured) {
    return h('section', { class: 'card glass' }, head(h('span', { class: 'pill' }, 'не настроено')), h('p', { class: 'two-lines' }, 'Запас не указан.'), h('p', { class: 'muted two-lines' }, 'Укажите остаток, и появится прогноз, до какого числа его хватит.'), h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => sheetEditSupply(kind) }, 'Указать запас')));
  }

  let stockText;
  let info;
  if (kind === 'insulin') {
    info = insulinInfo(state, now);
    stockText = `Дома ${fmtNum(info.home)} ед: ${s.fullPacks} ${plural(s.fullPacks, ['упаковка', 'упаковки', 'упаковок'])} по ${s.packUnits} и ${fmtNum(s.openedUnits)} в начатой.`;
  } else {
    info = stockInfo(state, now, kind);
    stockText = `В запасе ${s.stock} шт.`;
  }
  const status = statusByDays(info.daysLeft, s.reserveDays, s.reserveDays / 2);
  const days = info.daysLeft == null ? null : Math.max(0, Math.floor(info.daysLeft));

  return h(
    'section',
    { class: 'card glass' },
    head(h('span', { class: 'pill ' + (days == null ? '' : status) }, days == null ? 'нет прогноза' : `на ${days} ${plural(days, DAYS)}`)),
    h('p', { class: 'two-lines' }, stockText),
    info.runOut
      ? h('p', { class: 'muted two-lines' }, `Хватит до ${fmtDate(info.runOut, true)}. Пополнить стоит до ${fmtDate(info.orderBy, true)}.`)
      : h('p', { class: 'muted two-lines' }, kind === 'reservoirs' ? 'Прогноз появится после первой записи о заправке.' : 'Прогноз появится после первой записи о смене.'),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => sheetRestock(kind) }, 'Пополнить'),
      h('button', { class: 'btn', type: 'button', onclick: () => sheetEditSupply(kind) }, 'Изменить'),
    ),
  );
}

function eventText(e) {
  if (e.type === 'set') return `Смена набора${e.site ? ', ' + e.site.toLowerCase() : ''}`;
  if (e.type === 'reservoir') return `Заправка резервуара, ${fmtNum(e.units)} ед`;
  if (e.type === 'sensor') return 'Новый датчик';
  if (e.type === 'restock') return `Пополнение: ${SUPPLY_TITLES[e.item].toLowerCase()}, +${e.qty}`;
  return e.type;
}

export function supplies() {
  const now = Date.now();
  const events = [...data.state.events].sort((a, b) => b.at - a.at).slice(0, 40);
  const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

  return h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'page-head with-action' },
      h('div', {}, h('h1', {}, 'Запасы'), h('p', { class: 'lead' }, 'Сколько осталось и когда пополнять.')),
      h('button', { class: 'btn', type: 'button', onclick: sheetTravel }, 'Собрать в поездку'),
    ),
    h('div', { class: 'grid-2' }, ['insulin', 'sets', 'reservoirs', 'sensors'].map((k) => supplyCard(k, now))),
    h(
      'section',
      { class: 'card glass' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Журнал')),
      events.length
        ? h(
            'div',
            { class: 'rows' },
            events.map((e) =>
              h(
                'div',
                { class: 'row' },
                h('div', { class: 'row-main' }, h('b', {}, eventText(e)), h('span', { class: 'muted' }, `${fmtDate(e.at, true)}, ${timeFmt.format(e.at)}`)),
                h(
                  'button',
                  {
                    class: 'icon-btn',
                    type: 'button',
                    'aria-label': 'Удалить запись',
                    title: 'Удалить запись и вернуть списанное в запас',
                    onclick: () => confirm('Удалить запись? Списанное вернётся в запас.') && removeEvent(e.id),
                  },
                  icon('trash', 18),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, 'Записи появятся, когда вы отметите смену набора, заправку резервуара, новый датчик или пополнение.'),
    ),
  );
}
