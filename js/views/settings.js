import { data, commit, exportBackup, importBackup, replaceAll, defaults } from '../store.js';
import { h, toast, pickFile, download, fmtDate, plural } from '../ui.js';
import { reminders, ymd } from '../logic.js';
import * as gcal from '../gcal.js';
import { loadDemo, clearDemo } from './today.js';

export function applyTheme() {
  const t = data.state.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

let busy = false;
// Если тихое обновление не удалось, не повторяем его, пока человек сам не нажмёт кнопку.
let autoBlocked = false;

export async function syncCalendar(interactive) {
  const g = data.state.gcal;
  if (busy || !g.clientId || (!interactive && autoBlocked)) return;
  busy = true;
  commit();
  try {
    const changed = await gcal.sync(g, reminders(data.state, Date.now()), { interactive });
    autoBlocked = false;
    if (interactive) toast(changed ? `Календарь обновлён: ${changed} ${plural(changed, ['событие', 'события', 'событий'])}` : 'В календаре уже всё актуально');
  } catch (e) {
    console.error(e);
    autoBlocked = true;
    if (interactive) toast(`Календарь не обновлён: ${e.message}`);
  } finally {
    busy = false;
    commit();
  }
}

function calendarCard() {
  const g = data.state.gcal;
  const list = reminders(data.state, Date.now());
  const connected = !!g.calendarId;
  const pending = connected ? gcal.pendingCount(g, list) : 0;
  if (g.clientId) gcal.preload().catch(() => {});

  const idInput = h('input', { id: 'g-client', type: 'text', value: g.clientId, placeholder: '1234567890-abc.apps.googleusercontent.com', autocomplete: 'off', spellcheck: 'false' });
  const timeInput = h('input', { id: 'g-time', type: 'time', value: g.time });
  const saveFields = () => {
    g.clientId = idInput.value.trim();
    g.time = timeInput.value || '09:00';
  };
  idInput.onchange = timeInput.onchange = () => (saveFields(), commit());

  const status = !connected
    ? 'Не подключён.'
    : `Подключён. В календаре «Диабет-контроль» ${Object.keys(g.eventIds).length} ${plural(Object.keys(g.eventIds).length, ['событие', 'события', 'событий'])}` +
      (g.lastSync ? `, обновлено ${fmtDate(g.lastSync)}.` : '.') +
      (pending ? ` Ждут отправки изменения: ${pending}.` : '');

  return h(
    'section',
    { class: 'card glass' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Google Календарь'), pending > 0 && h('span', { class: 'pill warn' }, 'есть изменения')),
    h('p', {}, 'Приложение создаёт отдельный календарь «Диабет-контроль» и держит в нём покупки, смены и визиты. Доступа к остальным вашим календарям оно не получает.'),
    h('p', { class: 'muted' }, status),
    h(
      'div',
      { class: 'form' },
      h('div', { class: 'field' }, h('label', { for: 'g-client' }, 'Client ID'), idInput),
      h('div', { class: 'field' }, h('label', { for: 'g-time' }, 'Во сколько напоминать'), timeInput),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            disabled: busy,
            onclick: () => {
              saveFields();
              if (!g.clientId) return toast('Сначала вставьте Client ID');
              syncCalendar(true);
            },
          },
          busy ? 'Обновляю…' : connected ? 'Синхронизировать сейчас' : 'Подключить календарь',
        ),
        connected &&
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                if (!confirm('Отключить календарь? Уже созданные события останутся в Google Календаре, удалить их можно там же.')) return;
                gcal.disconnect(g);
                commit();
              },
            },
            'Отключить',
          ),
      ),
    ),
    h(
      'details',
      { class: 'details' },
      h('summary', {}, 'Как получить Client ID'),
      h(
        'ol',
        {},
        h('li', {}, 'Откройте console.cloud.google.com и создайте проект.'),
        h('li', {}, 'В разделе «APIs & Services» включите Google Calendar API.'),
        h('li', {}, 'Настройте экран согласия OAuth: тип External, в тестовые пользователи добавьте свой адрес Gmail.'),
        h('li', {}, 'Создайте учётные данные «OAuth client ID» типа Web application.'),
        h('li', {}, 'В поле Authorized JavaScript origins добавьте адрес этого приложения: ', h('code', {}, location.origin)),
        h('li', {}, 'Скопируйте Client ID в поле выше и нажмите «Подключить календарь».'),
      ),
      h('p', { class: 'hint' }, 'Вход Google действует около часа. Пока он активен, календарь обновляется сам после каждого изменения. Потом достаточно нажать «Синхронизировать сейчас».'),
    ),
  );
}

export function settings() {
  const state = data.state;
  const hasData = Object.values(state.supplies).some((s) => s.configured) || state.schedule.length || data.glucose.length;

  return h(
    'div',
    { class: 'page' },
    h('header', { class: 'page-head' }, h('h1', {}, 'Настройки')),
    h(
      'div',
      { class: 'grid-2' },
      calendarCard(),
      h(
        'div',
        { class: 'stack-cards' },
        h(
          'section',
          { class: 'card glass' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Оформление')),
          h(
            'div',
            { class: 'seg', role: 'group', 'aria-label': 'Тема' },
            [['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([v, l]) =>
              h('button', { type: 'button', 'aria-pressed': String(state.theme === v), onclick: () => ((state.theme = v), applyTheme(), commit()) }, l),
            ),
          ),
        ),
        h(
          'section',
          { class: 'card glass' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Ваши данные')),
          h('p', {}, 'Всё хранится только в этом браузере на этом устройстве. Чтобы перенести данные на телефон или не потерять их, сохраняйте резервную копию.'),
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'btn primary', type: 'button', onclick: () => (download(`diabetes-control-${ymd(Date.now())}.json`, exportBackup()), toast('Резервная копия сохранена')) }, 'Сохранить резервную копию'),
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: async () => {
                  const file = await pickFile('.json,application/json');
                  if (!file) return;
                  if (hasData && !confirm('Данные из файла заменят всё, что сейчас есть в приложении. Продолжить?')) return;
                  try {
                    await importBackup(file.text);
                    applyTheme();
                    toast('Данные восстановлены из копии');
                  } catch (e) {
                    toast(`Копия не загружена: ${e.message}`);
                  }
                },
              },
              'Восстановить из копии',
            ),
          ),
          h(
            'div',
            { class: 'actions' },
            state.demo
              ? h('button', { class: 'btn', type: 'button', onclick: clearDemo }, 'Удалить демо-данные')
              : !hasData && h('button', { class: 'btn', type: 'button', onclick: loadDemo }, 'Показать на демо-данных'),
            hasData &&
              !state.demo &&
              h(
                'button',
                {
                  class: 'btn danger-text',
                  type: 'button',
                  onclick: async () => {
                    if (!confirm('Удалить все данные приложения на этом устройстве? Это нельзя отменить.')) return;
                    await replaceAll({ state: defaults(), glucose: [], pump: { days: {} } });
                    applyTheme();
                  },
                },
                'Удалить все данные',
              ),
          ),
        ),
        h(
          'section',
          { class: 'card glass' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Важно')),
          h('p', { class: 'muted' }, 'Приложение помогает помнить о сроках и видеть общую картину. Оно не подбирает дозы и не заменяет врача. Прогнозы запасов и остаток в резервуаре считаются по среднему расходу и могут расходиться с реальностью: сверяйтесь с помпой.'),
        ),
      ),
    ),
  );
}
