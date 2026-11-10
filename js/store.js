// Данные приложения. Всё хранится в IndexedDB этого браузера и никуда не отправляется.

const DB_NAME = 'diabetes-control';
const STORE = 'kv';
let dbPromise;

function db() {
  return (dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
async function idbGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function defaults() {
  return {
    version: 1,
    demo: false,
    theme: 'auto',
    supplies: {
      insulin: { name: 'Ринфаст', configured: false, fullPacks: 0, packUnits: 300, openedUnits: 0, dailyUnits: null, reserveDays: 14 },
      sets: { name: 'Medtronic Quick-set', configured: false, stock: 0, intervalDays: 3, reserveDays: 14 },
      reservoirs: { name: 'MiniMed', configured: false, stock: 0, mode: 'withSet', fillUnits: null, reserveDays: 14 },
      sensors: { name: 'Ottai', configured: false, stock: 0, wearDays: 14, reserveDays: 14 },
    },
    events: [],
    schedule: [],
    gcal: { clientId: '', calendarId: '', eventIds: {}, sigs: {}, time: '09:00', lastSync: null },
    imports: { glucose: null, pump: null },
  };
}

/** Живые данные. state: настройки и журнал, glucose: [[ts, ммоль/л]], pump: суточные итоги помпы. */
export const data = { state: defaults(), glucose: [], pump: { days: {} } };

const listeners = new Set();
export const subscribe = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn());

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export async function load() {
  try {
    const [state, glucose, pump] = await Promise.all([idbGet('state'), idbGet('glucose'), idbGet('pump')]);
    if (state) {
      const base = defaults();
      data.state = { ...base, ...state, supplies: { ...base.supplies }, gcal: { ...base.gcal, ...state.gcal }, imports: { ...base.imports, ...state.imports } };
      for (const k of Object.keys(base.supplies)) data.state.supplies[k] = { ...base.supplies[k], ...(state.supplies?.[k] || {}) };
    }
    if (glucose) data.glucose = glucose;
    if (pump) data.pump = pump;
    navigator.storage?.persist?.();
  } catch (err) {
    console.error('Не удалось прочитать сохранённые данные', err);
    data.loadError = String(err?.message || err);
  }
}

let saveTimer;
/** Сохранить настройки и журнал, перерисовать экран. */
export function commit() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => idbSet('state', data.state).catch((e) => console.error(e)), 120);
  emit();
}
export async function saveGlucose() {
  await idbSet('glucose', data.glucose);
}
export async function savePump() {
  await idbSet('pump', data.pump);
}

export async function replaceAll(next) {
  data.state = next.state;
  data.glucose = next.glucose || [];
  data.pump = next.pump || { days: {} };
  await Promise.all([idbSet('state', data.state), idbSet('glucose', data.glucose), idbSet('pump', data.pump)]);
  emit();
}

// ---------- Журнал событий и запасы ----------

function takeInsulin(units) {
  const s = data.state.supplies.insulin;
  let packsOpened = 0;
  while (s.openedUnits < units && s.fullPacks > 0) {
    s.fullPacks--;
    s.openedUnits += s.packUnits;
    packsOpened++;
  }
  const taken = Math.min(units, s.openedUnits);
  s.openedUnits -= taken;
  return { taken, packsOpened };
}

/** Записывает событие и списывает расходник из запаса. */
export function logEvent(ev) {
  const S = data.state.supplies;
  ev.id = uid();
  const stockKey = { set: 'sets', reservoir: 'reservoirs', sensor: 'sensors' }[ev.type];
  // noStock: запись из данных помпы, которая только ставит таймер и запас не трогает.
  if (stockKey && !ev.noStock) {
    ev.used = S[stockKey].stock > 0 ? 1 : 0;
    S[stockKey].stock -= ev.used;
  }
  if (ev.type === 'reservoir' && !ev.noStock) {
    Object.assign(ev, takeInsulin(ev.units));
    S.reservoirs.fillUnits = ev.units;
  }
  if (ev.type === 'restock') {
    if (ev.item === 'insulin') S.insulin.fullPacks += ev.qty;
    else S[ev.item].stock += ev.qty;
  }
  data.state.events.push(ev);
  commit();
}

/** Удаляет событие и возвращает списанное в запас. */
export function removeEvent(id) {
  const S = data.state.supplies;
  const i = data.state.events.findIndex((e) => e.id === id);
  if (i < 0) return;
  const [ev] = data.state.events.splice(i, 1);
  const stockKey = { set: 'sets', reservoir: 'reservoirs', sensor: 'sensors' }[ev.type];
  if (stockKey) S[stockKey].stock += ev.used || 0;
  if (ev.type === 'reservoir') {
    S.insulin.openedUnits += ev.taken || 0;
    let packs = ev.packsOpened || 0;
    while (packs > 0 && S.insulin.openedUnits >= S.insulin.packUnits) {
      S.insulin.openedUnits -= S.insulin.packUnits;
      S.insulin.fullPacks++;
      packs--;
    }
  }
  if (ev.type === 'restock') {
    if (ev.item === 'insulin') S.insulin.fullPacks = Math.max(0, S.insulin.fullPacks - ev.qty);
    else S[ev.item].stock = Math.max(0, S[ev.item].stock - ev.qty);
  }
  commit();
}

export function exportBackup() {
  return JSON.stringify({ app: 'diabetes-control', version: 1, exportedAt: new Date().toISOString(), state: data.state, glucose: data.glucose, pump: data.pump });
}

export async function importBackup(text) {
  const parsed = JSON.parse(text);
  if (parsed.app !== 'diabetes-control' || !parsed.state) throw new Error('Это не файл резервной копии этого приложения.');
  const base = defaults();
  const state = { ...base, ...parsed.state, gcal: { ...base.gcal, ...parsed.state.gcal }, imports: { ...base.imports, ...parsed.state.imports } };
  await replaceAll({ state, glucose: parsed.glucose, pump: parsed.pump });
}
