// Синхронизация дел с Google Календарём прямо из браузера.
// Доступ запрашивается только к календарям, которые создаёт само приложение (scope calendar.app.created).

import { ymd, startOfDay } from './logic.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const API = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_NAME = 'Диабет-контроль';

let token = null;
let tokenExp = 0;

export const hasToken = () => !!token && Date.now() < tokenExp - 60000;

/** Подгружает скрипт входа Google заранее, чтобы окно входа открывалось сразу по нажатию. */
export function preload() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Не удалось загрузить вход Google. Проверьте подключение к интернету.'));
    document.head.append(s);
  });
}

async function getToken(clientId, interactive) {
  if (hasToken()) return token;
  if (!interactive) throw new Error('Нужно войти в Google заново.');
  await preload();
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        token = r.access_token;
        tokenExp = Date.now() + Number(r.expires_in) * 1000;
        resolve(token);
      },
      error_callback: (e) => reject(new Error(e?.message || 'Окно входа Google закрыто или заблокировано.')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

async function api(path, method = 'GET', body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const err = new Error(`Google Календарь ответил ошибкой ${res.status}`);
    err.status = res.status;
    try {
      err.message = (await res.json()).error?.message || err.message;
    } catch {}
    throw err;
  }
  return res.json();
}

const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

export function eventBody(rem, time, now = Date.now()) {
  // Просроченное дело ставим на сегодня, иначе напоминание уже не сработает.
  const [y, m, d] = rem.date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  let start = new Date(y, m - 1, d, hh, mm);
  if (start.getTime() < startOfDay(now)) {
    start = new Date(startOfDay(now));
    start.setHours(hh, mm);
  }
  const end = new Date(start.getTime() + 30 * 60000);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    summary: rem.title,
    description: `${rem.note}\n\nСоздано приложением «${CALENDAR_NAME}».`,
    start: { dateTime: localIso(start), timeZone },
    end: { dateTime: localIso(end), timeZone },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
  };
}

/** Сколько дел в календаре отличается от приложения. */
export function pendingCount(gcal, list, now = Date.now()) {
  let n = 0;
  const keys = new Set(list.map((r) => r.key));
  for (const key of Object.keys(gcal.eventIds)) if (!keys.has(key)) n++;
  for (const r of list) if (gcal.sigs[r.key] !== JSON.stringify(eventBody(r, gcal.time, now))) n++;
  return n;
}

/** Приводит календарь в соответствие со списком дел. Меняет gcal (calendarId, eventIds, sigs). */
export async function sync(gcal, list, { interactive = false } = {}) {
  await getToken(gcal.clientId, interactive);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const createCalendar = async () => {
    const cal = await api('/calendars', 'POST', { summary: CALENDAR_NAME, timeZone });
    gcal.calendarId = cal.id;
    gcal.eventIds = {};
    gcal.sigs = {};
  };
  if (!gcal.calendarId) await createCalendar();
  else {
    try {
      await api(`/calendars/${encodeURIComponent(gcal.calendarId)}`);
    } catch (e) {
      if (e.status === 404 || e.status === 410) await createCalendar();
      else throw e;
    }
  }
  const base = `/calendars/${encodeURIComponent(gcal.calendarId)}/events`;
  const wanted = new Set(list.map((r) => r.key));
  let changed = 0;

  for (const [key, id] of Object.entries(gcal.eventIds)) {
    if (wanted.has(key)) continue;
    try {
      await api(`${base}/${id}`, 'DELETE');
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
    }
    delete gcal.eventIds[key];
    delete gcal.sigs[key];
    changed++;
  }

  for (const r of list) {
    const body = eventBody(r, gcal.time);
    const sig = JSON.stringify(body);
    if (gcal.eventIds[r.key] && gcal.sigs[r.key] === sig) continue;
    let done = false;
    if (gcal.eventIds[r.key]) {
      try {
        await api(`${base}/${gcal.eventIds[r.key]}`, 'PUT', body);
        done = true;
      } catch (e) {
        if (e.status !== 404 && e.status !== 410) throw e;
      }
    }
    if (!done) gcal.eventIds[r.key] = (await api(base, 'POST', body)).id;
    gcal.sigs[r.key] = sig;
    changed++;
  }
  gcal.lastSync = Date.now();
  return changed;
}

export function disconnect(gcal) {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  token = null;
  tokenExp = 0;
  gcal.calendarId = '';
  gcal.eventIds = {};
  gcal.sigs = {};
  gcal.lastSync = null;
}
