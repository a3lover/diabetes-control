// Демонстрационные данные, чтобы посмотреть экраны до ввода своих. Помечаются флагом demo.

import { defaults, uid } from './store.js';
import { ymd, DAY } from './logic.js';

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export function makeDemo(now = Date.now()) {
  const rand = rng(720);
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * 1.2;

  const glucose = [];
  const start = now - 30 * DAY;
  let noise = 0;
  let dayShift = 0;
  let nightLow = false;
  for (let ts = start; ts <= now; ts += 5 * 60000) {
    const d = new Date(ts);
    const hour = d.getHours() + d.getMinutes() / 60;
    if (d.getHours() === 0 && d.getMinutes() < 5) {
      dayShift = gauss() * 1.6;
      nightLow = rand() < 0.2;
    }
    const meal = (at, size) => {
      const x = hour - at;
      return x > 0 && x < 3.5 ? size * Math.exp(-((x - 1.1) ** 2) / 0.9) : 0;
    };
    noise = noise * 0.96 + gauss() * 0.22;
    let v = 7.2 + dayShift + 0.6 * Math.sin(((hour - 5) / 24) * 2 * Math.PI) + meal(8.5, 4.4) + meal(13.5, 3.4) + meal(19.5, 4.8) + noise;
    if (nightLow && hour > 2.5 && hour < 4.5) v -= 3.6 * Math.exp(-((hour - 3.5) ** 2) / 0.3);
    glucose.push([ts, Math.round(Math.min(22, Math.max(2.2, v)) * 10) / 10]);
  }

  const days = {};
  for (let i = 1; i <= 30; i++) {
    days[ymd(now - i * DAY)] = {
      bolus: Math.round((22 + gauss() * 3.5) * 10) / 10,
      basal: Math.round((18.2 + gauss() * 0.6) * 10) / 10,
      carbs: Math.round(185 + gauss() * 35),
      boluses: Math.round(5 + gauss()),
    };
  }

  const state = defaults();
  state.demo = true;
  Object.assign(state.supplies.insulin, { configured: true, fullPacks: 2, openedUnits: 140, dailyUnits: 40 });
  Object.assign(state.supplies.sets, { configured: true, stock: 6 });
  Object.assign(state.supplies.reservoirs, { configured: true, stock: 9, fillUnits: 150 });
  Object.assign(state.supplies.sensors, { configured: true, stock: 1 });
  state.events = [
    { id: uid(), type: 'sensor', at: now - 11.6 * DAY, used: 1 },
    { id: uid(), type: 'set', at: now - 5.2 * DAY, site: 'Живот справа', used: 1 },
    { id: uid(), type: 'reservoir', at: now - 5.2 * DAY, units: 150, used: 1, taken: 150, packsOpened: 0 },
    { id: uid(), type: 'set', at: now - 2.3 * DAY, site: 'Живот слева', used: 1 },
    { id: uid(), type: 'reservoir', at: now - 2.3 * DAY, units: 150, used: 1, taken: 150, packsOpened: 1 },
  ];
  const ago = (n) => ymd(now - n * DAY);
  state.schedule = [
    { id: uid(), group: 'endo', title: 'Приём эндокринолога и рецепты', intervalMonths: 1, lastDone: ago(24), appointment: null, unit: '', note: '', results: [] },
    { id: uid(), group: 'lab', title: 'Гликированный гемоглобин (HbA1c)', intervalMonths: 3, lastDone: ago(96), appointment: null, unit: '%', note: '', results: [{ date: ago(190), value: 7.4 }, { date: ago(96), value: 6.9 }] },
    { id: uid(), group: 'lab', title: 'Биохимия крови: билирубин, АЛТ, АСТ, креатинин, холестерин', intervalMonths: 12, lastDone: ago(340), appointment: null, unit: '', note: '', results: [] },
    { id: uid(), group: 'doctor', title: 'Офтальмолог: осмотр глазного дна', intervalMonths: 12, lastDone: ago(150), appointment: null, unit: '', note: '', results: [] },
  ];
  state.imports = { glucose: { at: now, name: 'демо' }, pump: { at: now, name: 'демо' } };
  return { state, glucose, pump: { days } };
}
