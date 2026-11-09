import { data, load, subscribe } from './store.js';
import { h, icon } from './ui.js';
import { reminders } from './logic.js';
import * as gcal from './gcal.js';
import { today } from './views/today.js';
import { supplies } from './views/supplies.js';
import { health } from './views/health.js';
import { analytics } from './views/analytics.js';
import { settings, applyTheme, syncCalendar } from './views/settings.js';

const ROUTES = {
  today: { view: today, label: 'Сегодня', icon: 'today' },
  supplies: { view: supplies, label: 'Запасы', icon: 'supplies' },
  health: { view: health, label: 'Здоровье', icon: 'health' },
  analytics: { view: analytics, label: 'Сахара', icon: 'sugar' },
  settings: { view: settings, label: 'Настройки', icon: 'settings' },
};

const root = document.getElementById('view');
const nav = document.getElementById('tabbar');
const current = () => {
  const name = location.hash.replace(/^#\/?/, '');
  return ROUTES[name] ? name : 'today';
};

function renderNav() {
  const active = current();
  nav.replaceChildren(
    ...Object.entries(ROUTES).map(([name, r]) => h('a', { href: `#/${name}`, 'aria-current': name === active ? 'page' : null }, icon(r.icon), h('span', {}, r.label))),
  );
}

function render() {
  const name = current();
  try {
    root.replaceChildren(ROUTES[name].view());
  } catch (err) {
    console.error(err);
    root.replaceChildren(h('div', { class: 'page' }, h('section', { class: 'card glass' }, h('h2', {}, 'Экран не открылся'), h('p', {}, `Ошибка: ${err.message}. Данные не потеряны. Сохраните резервную копию в настройках и сообщите об ошибке.`))));
  }
  document.title = `Диабет-контроль: ${ROUTES[name].label.toLowerCase()}`;
  renderNav();
}

// После изменений тихо обновляем календарь, пока вход Google ещё действует.
let syncTimer;
function autoSync() {
  const g = data.state.gcal;
  if (!g.calendarId || !gcal.hasToken()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (gcal.pendingCount(g, reminders(data.state, Date.now()))) syncCalendar(false);
  }, 2500);
}

await load();
applyTheme();
render();
subscribe(render);
subscribe(autoSync);
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});
// Сроки зависят от времени: обновляем экран, когда приложение снова открыли.
document.addEventListener('visibilitychange', () => !document.hidden && !document.querySelector('.sheet-wrap') && render());

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
