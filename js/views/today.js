import { data, replaceAll, defaults } from '../store.js';
import { h, fmtDate, fmtNum, relDay, plural, DAYS } from '../ui.js';
import { insulinInfo, reservoirInfo, wearInfo, reminders, statusByDays, dayDiff, clamp, fromYmd, DAY } from '../logic.js';
import { analyze } from '../metrics.js';
import { sheetSetChange, sheetReservoir, sheetSensor, sheetRestock, sheetEditSupply } from '../actions.js';
import { makeDemo } from '../demo.js';
import { tirBar } from './analytics.js';

// Все плитки устроены одинаково: колба, короткое название, одно значение в строку,
// пояснение ровно в две строки и кнопка. Поэтому они совпадают по размеру при любых данных.
function tile({ title, value, sub, level, status, action, onAction }) {
  return h(
    'article',
    { class: 'tile glass', 'data-status': status },
    h(
      'div',
      { class: 'tile-top' },
      h('div', { class: 'vial', style: { '--level': clamp(level ?? 0).toFixed(3) }, 'aria-hidden': 'true' }, h('span', { class: 'liquid' })),
      h('div', { class: 'tile-text' }, h('h3', {}, title), h('p', { class: 'tile-value' }, value)),
    ),
    h('p', { class: 'tile-sub' }, sub),
    h('button', { class: 'btn', type: 'button', onclick: onAction }, action),
  );
}

const setupTile = (title, kind) =>
  tile({ title, value: '–', sub: 'Не настроено: укажите запас', level: 0, status: 'none', action: 'Настроить', onAction: () => sheetEditSupply(kind) });

/** Сколько осталось до срока: «3 дня», «завтра», «сегодня», «пора». */
const untilText = (d) => (d < 0 ? 'пора' : d === 0 ? 'сегодня' : d === 1 ? 'завтра' : `${d} ${plural(d, DAYS)}`);

function supplyTiles(state, now) {
  const S = state.supplies;
  const tiles = [];

  if (!S.insulin.configured || !S.insulin.dailyUnits) tiles.push(setupTile('Инсулин', 'insulin'));
  else {
    const i = insulinInfo(state, now);
    const days = Math.floor(i.daysLeft);
    tiles.push(
      tile({
        title: 'Инсулин',
        value: `${days} ${plural(days, DAYS)}`,
        sub: `${fmtNum(i.total)} ед, хватит до ${fmtDate(i.runOut)}`,
        level: i.daysLeft / 60,
        status: statusByDays(i.daysLeft, S.insulin.reserveDays, S.insulin.reserveDays / 2),
        action: 'Пополнить',
        onAction: () => sheetRestock('insulin'),
      }),
    );
  }

  if (!S.sets.configured) tiles.push(setupTile('Набор', 'sets'));
  else {
    const w = wearInfo(state, now, 'set');
    const d = w.due ? dayDiff(w.due, now) : null;
    tiles.push(
      tile({
        title: 'Набор',
        value: w.last ? untilText(d) : '–',
        sub: !w.last ? 'Отметьте последнюю смену' : d < 0 ? `срок вышел ${fmtDate(w.due)}` : `до смены, стоит с ${fmtDate(w.last.at)}`,
        level: w.level,
        status: w.last ? statusByDays(w.daysLeft, 1) : 'none',
        action: 'Сменил набор',
        onAction: sheetSetChange,
      }),
    );
  }

  if (!S.reservoirs.configured) tiles.push(setupTile('Резервуар', 'reservoirs'));
  else {
    const r = reservoirInfo(state, now);
    tiles.push(
      tile({
        title: 'Резервуар',
        value: !r.fill ? '–' : `${fmtNum(r.left ?? r.fill.units)} ед`,
        sub: !r.fill ? 'Отметьте последнюю заправку' : r.left == null ? 'набрано, укажите расход инсулина' : r.left <= 0 ? 'по расчёту уже пуст' : `по расчёту, до ${fmtDate(r.emptyAt)}`,
        level: r.level,
        status: r.fill && r.left != null ? statusByDays(r.daysLeft, 1, 0.4) : 'none',
        action: 'Заправил',
        onAction: sheetReservoir,
      }),
    );
  }

  if (!S.sensors.configured) tiles.push(setupTile('Датчик', 'sensors'));
  else {
    const w = wearInfo(state, now, 'sensor');
    const d = w.due ? dayDiff(w.due, now) : null;
    tiles.push(
      tile({
        title: 'Датчик',
        value: w.last ? untilText(d) : '–',
        sub: !w.last ? 'Отметьте, когда поставили' : d < 0 ? `срок вышел ${fmtDate(w.due)}` : `до смены ${fmtDate(w.due)}`,
        level: w.level,
        status: w.last ? statusByDays(w.daysLeft, 2) : 'none',
        action: 'Новый датчик',
        onAction: sheetSensor,
      }),
    );
  }
  return tiles;
}

/** Строка дела: дата, название и одна строка со сроком и пояснением. */
export function reminderRow(r) {
  const d = new Date(fromYmd(r.date));
  const month = new Intl.DateTimeFormat('ru-RU', { month: 'short' }).format(d).replace('.', '');
  const status = r.daysLeft < 0 ? 'danger' : r.daysLeft <= 3 ? 'warn' : 'ok';
  const when = r.daysLeft < 0 ? `Срок прошёл ${relDay(r.daysLeft)}` : relDay(r.daysLeft);
  return h(
    'div',
    { class: 'row' },
    h('div', { class: 'datebox', 'data-status': status }, h('b', {}, d.getDate()), h('span', {}, month)),
    h('div', { class: 'row-main' }, h('b', {}, r.title), h('span', { class: 'muted' }, h('span', { class: 'when ' + status }, when[0].toUpperCase() + when.slice(1)), `. ${r.note}`)),
  );
}

export async function loadDemo() {
  await replaceAll(makeDemo());
}
export async function clearDemo() {
  await replaceAll({ state: defaults(), glucose: [], pump: { days: {} } });
}

export function today() {
  const { state, glucose } = data;
  const now = Date.now();
  const list = reminders(state, now);
  const overdue = list.filter((r) => r.daysLeft <= 0).length;
  const soon = list.filter((r) => r.daysLeft <= 60);
  const empty = !Object.values(state.supplies).some((s) => s.configured) && !state.schedule.length && !glucose.length;

  const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(now);
  const lead = !list.length
    ? 'Пока нечего отслеживать. Начните с запасов.'
    : overdue
      ? `${overdue} ${plural(overdue, ['дело ждёт', 'дела ждут', 'дел ждут'])} вас сегодня или уже просрочено.`
      : `На сегодня ничего срочного. Ближайшее дело ${relDay(list[0].daysLeft)}.`;

  let sugar = null;
  if (glucose.length) {
    const to = glucose[glucose.length - 1][0] + 1;
    const a = analyze(glucose, to - 14 * DAY, to);
    if (a) {
      sugar = h(
        'section',
        { class: 'card glass' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Сахара за 14 дней'), h('a', { class: 'link', href: '#/analytics' }, 'Подробнее')),
        h('p', { class: 'lead-num' }, h('b', {}, fmtNum(a.pct.inr) + '%'), ' времени в цели, средний сахар ', h('b', {}, fmtNum(a.mean, 1)), ' ммоль/л'),
        tirBar(a, false),
        h('p', { class: 'hint' }, `Данные с ${fmtDate(a.first)} по ${fmtDate(a.last)}.`),
      );
    }
  }

  return h(
    'div',
    { class: 'page' },
    h('header', { class: 'page-head' }, h('h1', {}, `${weekday[0].toUpperCase()}${weekday.slice(1)}, ${fmtDate(now)}`), h('p', { class: 'lead' }, lead)),
    state.demo &&
      h('div', { class: 'banner glass' }, h('p', {}, h('b', {}, 'Это демо-данные. '), 'Цифры выдуманы, чтобы показать экраны. Удалите их перед вводом своих.'), h('button', { class: 'btn small', type: 'button', onclick: clearDemo }, 'Удалить демо-данные')),
    empty &&
      h(
        'div',
        { class: 'banner glass' },
        h('p', {}, h('b', {}, 'С чего начать. '), 'Настройте четыре плитки ниже, затем добавьте врачей и анализы на вкладке «Здоровье». Можно сначала посмотреть на примере.'),
        h('button', { class: 'btn small', type: 'button', onclick: loadDemo }, 'Показать на демо-данных'),
      ),
    h('section', { class: 'tiles', 'aria-label': 'Расходники' }, supplyTiles(state, now)),
    h(
      'section',
      { class: 'card glass' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Ближайшие дела'), h('a', { class: 'link', href: '#/health' }, 'Врачи и анализы')),
      soon.length ? h('div', { class: 'rows' }, soon.slice(0, 8).map(reminderRow)) : h('p', { class: 'empty' }, 'Здесь появятся покупки, смены и визиты на ближайшие два месяца, когда вы настроите запасы и добавите врачей.'),
    ),
    sugar,
  );
}
