// Чистые расчёты: даты, прогнозы запасов, сроки. Без DOM, чтобы можно было проверять отдельно.

export const DAY = 864e5;
const pad = (n) => String(n).padStart(2, '0');

export const ymd = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const fromYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
export const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** Разница в календарных днях: сколько дней от b до a. */
export const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / DAY);
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export function addMonths(s, n) {
  const d = new Date(fromYmd(s));
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return ymd(d);
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dateFmtY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
export const fmtDate = (t, withYear = false) => (withYear ? dateFmtY : dateFmt).format(new Date(t)).replace(' г.', '');

export function plural(n, forms) {
  const a = Math.abs(Math.round(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}
export const DAYS = ['день', 'дня', 'дней'];

/** «сегодня», «завтра», «через 5 дней», «3 дня назад» */
export function relDay(d) {
  if (d === 0) return 'сегодня';
  if (d === 1) return 'завтра';
  if (d === -1) return 'вчера';
  if (d > 0) return `через ${d} ${plural(d, DAYS)}`;
  return `${-d} ${plural(d, DAYS)} назад`;
}

// ---------- Расходники ----------

export function lastEvent(state, type) {
  let best = null;
  for (const e of state.events) if (e.type === type && (!best || e.at > best.at)) best = e;
  return best;
}

export const dailyUse = (state) => state.supplies.insulin.dailyUnits || null;

/** Сколько инсулина осталось в резервуаре: оценка по суточному расходу. */
export function reservoirInfo(state, now) {
  const fill = lastEvent(state, 'reservoir');
  if (!fill) return { fill: null };
  const daily = dailyUse(state);
  if (!daily) return { fill, left: null, emptyAt: null, daysLeft: null, level: null };
  const left = Math.max(0, fill.units - (daily * (now - fill.at)) / DAY);
  const emptyAt = fill.at + (fill.units / daily) * DAY;
  return { fill, left, emptyAt, daysLeft: (emptyAt - now) / DAY, level: fill.units ? left / fill.units : 0 };
}

/** Запас инсулина дома и в помпе, на сколько дней хватит. */
export function insulinInfo(state, now) {
  const s = state.supplies.insulin;
  const home = s.fullPacks * s.packUnits + s.openedUnits;
  const total = home + (reservoirInfo(state, now).left || 0);
  const daily = dailyUse(state);
  if (!daily) return { home, total, daily: null, daysLeft: null };
  const daysLeft = total / daily;
  return { home, total, daily, daysLeft, runOut: now + daysLeft * DAY, orderBy: now + (daysLeft - s.reserveDays) * DAY };
}

/** Срок носки того, что меняется по дням: набор ('set') или датчик ('sensor'). */
export function wearInfo(state, now, type) {
  const days = type === 'set' ? state.supplies.sets.intervalDays : state.supplies.sensors.wearDays;
  const last = lastEvent(state, type);
  if (!last || !days) return { last, days };
  const due = last.at + days * DAY;
  return { last, days, due, daysLeft: (due - now) / DAY, level: clamp((due - now) / (days * DAY)) };
}

/** На сколько хватит штучного запаса: 'sets' | 'reservoirs' | 'sensors'. */
export function stockInfo(state, now, kind) {
  const s = state.supplies[kind];
  let life = null;
  let currentEnd = null;
  if (kind === 'sets') {
    life = s.intervalDays;
    currentEnd = wearInfo(state, now, 'set').due;
  } else if (kind === 'sensors') {
    life = s.wearDays;
    currentEnd = wearInfo(state, now, 'sensor').due;
  } else {
    const r = reservoirInfo(state, now);
    const daily = dailyUse(state);
    if (s.mode === 'withSet') {
      life = state.supplies.sets.intervalDays;
      currentEnd = wearInfo(state, now, 'set').due;
    } else if (r.fill && daily) {
      life = r.fill.units / daily;
      currentEnd = r.emptyAt;
    } else if (s.fillUnits && daily) {
      life = s.fillUnits / daily;
    }
  }
  if (!life) return { stock: s.stock, life: null };
  const runOut = Math.max(now, currentEnd || now) + s.stock * life * DAY;
  return { stock: s.stock, life, runOut, daysLeft: (runOut - now) / DAY, orderBy: runOut - s.reserveDays * DAY };
}

export function statusByDays(daysLeft, warnAt, dangerAt = 0) {
  if (daysLeft == null) return 'none';
  if (daysLeft <= dangerAt) return 'danger';
  if (daysLeft <= warnAt) return 'warn';
  return 'ok';
}

// ---------- Врачи и анализы ----------

/** Следующая дата: запись, если есть, иначе последний раз + периодичность. */
export function scheduleNext(item) {
  if (item.appointment) return item.appointment;
  if (item.lastDone && item.intervalMonths) return addMonths(item.lastDone, item.intervalMonths);
  return null;
}

// ---------- Единый список дел (для экрана «Сегодня» и календаря) ----------

export function reminders(state, now) {
  const out = [];
  const S = state.supplies;
  const push = (key, title, t, note, kind) =>
    out.push({ key, title, date: ymd(t), note, kind, daysLeft: dayDiff(t, now) });

  if (S.insulin.configured) {
    const i = insulinInfo(state, now);
    if (i.daysLeft != null) {
      push('insulin', `Получить инсулин ${S.insulin.name}`, i.orderBy, `Запаса хватит до ${fmtDate(i.runOut)}`, 'supply');
    }
  }
  if (S.sets.configured) {
    const w = wearInfo(state, now, 'set');
    if (w.due) push('set', 'Сменить инфузионный набор', w.due, `Установлен ${fmtDate(w.last.at)}`, 'change');
    const st = stockInfo(state, now, 'sets');
    if (st.runOut) push('buy-sets', 'Купить инфузионные наборы', st.orderBy, `В запасе ${st.stock} шт., хватит до ${fmtDate(st.runOut)}`, 'supply');
  }
  if (S.reservoirs.configured) {
    const st = stockInfo(state, now, 'reservoirs');
    if (st.runOut) push('buy-reservoirs', 'Купить резервуары', st.orderBy, `В запасе ${st.stock} шт., хватит до ${fmtDate(st.runOut)}`, 'supply');
  }
  if (S.sensors.configured) {
    const w = wearInfo(state, now, 'sensor');
    if (w.due) push('sensor', `Сменить датчик ${S.sensors.name}`, w.due, `Установлен ${fmtDate(w.last.at)}`, 'change');
    const st = stockInfo(state, now, 'sensors');
    if (st.runOut) push('buy-sensors', `Купить датчики ${S.sensors.name}`, st.orderBy, `В запасе ${st.stock} шт., хватит до ${fmtDate(st.runOut)}`, 'supply');
  }
  for (const item of state.schedule) {
    const next = scheduleNext(item);
    if (next) push('sch-' + item.id, item.title, fromYmd(next), item.appointment ? 'Вы записаны на этот день' : 'Плановый срок', 'health');
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Сборы в поездку ----------

export function travelNeeds(state, days, reservePct) {
  const k = 1 + reservePct / 100;
  const S = state.supplies;
  const daily = dailyUse(state);
  const resLife = S.reservoirs.mode === 'withSet' || !S.reservoirs.fillUnits || !daily ? S.sets.intervalDays : S.reservoirs.fillUnits / daily;
  return {
    insulin: daily ? Math.ceil(daily * days * k) : null,
    sets: S.sets.intervalDays ? Math.ceil((days / S.sets.intervalDays) * k) : null,
    reservoirs: resLife ? Math.ceil((days / resLife) * k) : null,
    sensors: S.sensors.wearDays ? Math.ceil((days / S.sensors.wearDays) * k) : null,
  };
}
