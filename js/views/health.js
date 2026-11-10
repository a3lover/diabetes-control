import { data, commit, uid } from '../store.js';
import { h, icon, form, openSheet, toast, fmtDate, fmtNum, relDay, plural } from '../ui.js';
import { scheduleNext, dayDiff, fromYmd, ymd } from '../logic.js';

const GROUPS = [
  ['endo', 'Эндокринолог и рецепты'],
  ['lab', 'Анализы'],
  ['doctor', 'Врачи и обследования'],
];

// Шаблоны по общим рекомендациям для диабета 1 типа. Сроки нужно сверить со своим врачом.
const TEMPLATES = [
  { group: 'endo', title: 'Приём эндокринолога и рецепты', intervalMonths: null, unit: '' },
  { group: 'lab', title: 'Гликированный гемоглобин (HbA1c)', intervalMonths: 3, unit: '%' },
  { group: 'lab', title: 'Биохимия крови: билирубин, АЛТ, АСТ, креатинин, холестерин', intervalMonths: 12, unit: '' },
  { group: 'lab', title: 'Общий анализ крови', intervalMonths: 12, unit: '' },
  { group: 'lab', title: 'Общий анализ мочи', intervalMonths: 12, unit: '' },
  { group: 'lab', title: 'Альбумин и креатинин в моче', intervalMonths: 12, unit: '' },
  { group: 'doctor', title: 'Офтальмолог: осмотр глазного дна', intervalMonths: 12, unit: '' },
  { group: 'doctor', title: 'Невролог: осмотр стоп', intervalMonths: 12, unit: '' },
  { group: 'doctor', title: 'ЭКГ', intervalMonths: 12, unit: '' },
];

const every = (m) => (!m ? 'периодичность не указана' : m === 1 ? 'раз в месяц' : m === 12 ? 'раз в год' : `раз в ${m} ${plural(m, ['месяц', 'месяца', 'месяцев'])}`);

function statusOf(item, now) {
  const next = scheduleNext(item);
  if (!next) return { cls: 'none', text: 'Не запланировано', next: null };
  const d = dayDiff(fromYmd(next), now);
  if (d < 0) return { cls: 'danger', text: `просрочено, ${relDay(d)}`, next };
  return { cls: d <= 14 ? 'warn' : 'ok', text: relDay(d), next };
}

function itemFields(item) {
  return [
    { name: 'title', label: 'Название', value: item.title, required: true },
    { name: 'group', label: 'Раздел', type: 'select', value: item.group, options: GROUPS },
    { name: 'intervalMonths', label: 'Повторять каждые, месяцев', type: 'number', min: 1, step: 1, value: item.intervalMonths, hint: 'Оставьте пустым, если повторять не нужно.' },
    { name: 'lastDone', label: 'Когда было в последний раз', type: 'date', value: item.lastDone || '', max: ymd(Date.now()) },
    { name: 'unit', label: 'Единица результата', value: item.unit || '', placeholder: 'например, %', hint: 'Заполните, если хотите записывать числовой результат.' },
    { name: 'note', label: 'Заметка', type: 'textarea', value: item.note || '', placeholder: 'Клиника, кабинет, что взять с собой' },
  ];
}

function sheetEdit(item) {
  const isNew = !item.id;
  const close = openSheet(
    isNew ? 'Новое дело' : 'Изменить',
    form(itemFields(item), 'Сохранить', (v) => {
      Object.assign(item, v, { lastDone: v.lastDone || null });
      if (isNew) data.state.schedule.push({ ...item, id: uid(), appointment: null, results: [] });
      commit();
      close();
      toast('Сохранено');
    }),
  );
}

function sheetDone(item) {
  const close = openSheet(
    'Отметить выполненным',
    form(
      [
        { name: 'date', label: 'Когда', type: 'date', value: ymd(Date.now()), max: ymd(Date.now()), required: true },
        item.unit && { name: 'value', label: `Результат, ${item.unit}`, type: 'number', hint: 'Необязательно.' },
      ],
      'Отметить',
      (v) => {
        item.lastDone = v.date;
        item.appointment = null;
        if (v.value != null) {
          item.results.push({ date: v.date, value: v.value });
          item.results.sort((a, b) => a.date.localeCompare(b.date));
        }
        commit();
        close();
        const next = scheduleNext(item);
        toast(next ? `Отмечено. Следующий раз ${fmtDate(fromYmd(next), true)}` : 'Отмечено');
      },
    ),
  );
}

function sheetAppointment(item) {
  const close = openSheet(
    'Запись на дату',
    form(
      [
        { name: 'date', label: 'На какой день вы записаны', type: 'date', value: item.appointment || '', min: ymd(Date.now()) },
        { type: 'note', text: 'Запись заменяет плановый срок, пока вы не отметите дело выполненным. Очистите поле, чтобы убрать запись.' },
      ],
      'Сохранить',
      (v) => {
        item.appointment = v.date || null;
        commit();
        close();
      },
    ),
  );
}

function sheetItem(item) {
  const st = statusOf(item, Date.now());
  const act = (label, fn, cls = 'btn') =>
    h('button', { class: cls, type: 'button', onclick: () => (close(), fn(item)) }, label);
  const results = [...item.results].reverse();
  const close = openSheet(
    item.title,
    h(
      'div',
      { class: 'sheet-body' },
      h(
        'div',
        { class: 'rows compact' },
        h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Периодичность'), h('b', {}, every(item.intervalMonths))),
        h('div', { class: 'row' }, h('span', { class: 'muted' }, 'В последний раз'), h('b', {}, item.lastDone ? fmtDate(fromYmd(item.lastDone), true) : 'нет записи')),
        h('div', { class: 'row' }, h('span', { class: 'muted' }, item.appointment ? 'Вы записаны на' : 'Следующий раз'), h('b', {}, st.next ? fmtDate(fromYmd(st.next), true) : 'не запланировано')),
      ),
      item.note && h('p', { class: 'note' }, item.note),
      results.length > 0 && h('div', { class: 'results' }, h('h3', {}, 'Результаты'), h('div', { class: 'rows compact' }, results.map((r) => h('div', { class: 'row' }, h('span', { class: 'muted' }, fmtDate(fromYmd(r.date), true)), h('b', {}, `${fmtNum(r.value, 1)} ${item.unit}`))))),
      h('div', { class: 'stack' }, act('Отметить выполненным', sheetDone, 'btn primary'), act(item.appointment ? 'Изменить запись' : 'Записан на дату', sheetAppointment), act('Изменить', sheetEdit)),
      h(
        'button',
        {
          class: 'btn danger-text',
          type: 'button',
          onclick: () => {
            if (!confirm(`Удалить «${item.title}» вместе с историей результатов?`)) return;
            data.state.schedule = data.state.schedule.filter((x) => x !== item);
            commit();
            close();
          },
        },
        'Удалить',
      ),
    ),
  );
}

function sheetTemplates() {
  const existing = new Set(data.state.schedule.map((x) => x.title));
  const list = TEMPLATES.filter((t) => !existing.has(t.title));
  if (!list.length) return toast('Все шаблоны уже добавлены');
  const close = openSheet(
    'Добавить из шаблонов',
    h('p', { class: 'hint' }, 'Список и сроки составлены по общим рекомендациям для диабета 1 типа. Это отправная точка: уточните свой график у лечащего врача и поправьте сроки.'),
    form(
      list.map((t, i) => ({ name: 't' + i, type: 'checkbox', label: `${t.title}, ${every(t.intervalMonths)}`, value: false })),
      'Добавить выбранные',
      (v) => {
        const picked = list.filter((_, i) => v['t' + i]);
        if (!picked.length) return toast('Ничего не выбрано');
        for (const t of picked) data.state.schedule.push({ ...t, id: uid(), lastDone: null, appointment: null, note: '', results: [] });
        commit();
        close();
        toast(`Добавлено: ${picked.length}. Укажите, когда было в последний раз.`);
      },
    ),
  );
}

export function health() {
  const now = Date.now();
  const items = data.state.schedule;

  const group = ([key, title]) => {
    const list = items.filter((x) => x.group === key);
    if (!list.length) return null;
    return h(
      'section',
      { class: 'card glass' },
      h('div', { class: 'card-head' }, h('h2', {}, title)),
      h(
        'div',
        { class: 'rows' },
        list.map((item) => {
          const st = statusOf(item, now);
          const last = item.results.at(-1);
          const sub = [st.next ? `${item.appointment ? 'запись на' : 'срок'} ${fmtDate(fromYmd(st.next), true)}` : item.intervalMonths ? 'укажите, когда было в последний раз' : null, every(item.intervalMonths), last ? `последний результат ${fmtNum(last.value, 1)} ${item.unit}` : null].filter(Boolean).join(', ');
          // Все строки одного вида: название, строка со сроком и пояснением, стрелка.
          return h(
            'button',
            { class: 'row row-btn', type: 'button', onclick: () => sheetItem(item) },
            h('div', { class: 'row-main' }, h('b', {}, item.title), h('span', { class: 'muted' }, h('span', { class: 'when ' + st.cls }, st.text[0].toUpperCase() + st.text.slice(1)), `, ${sub}`)),
            icon('chevron', 18),
          );
        }),
      ),
    );
  };

  return h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'page-head with-action' },
      h('div', {}, h('h1', {}, 'Здоровье'), h('p', { class: 'lead' }, 'Визиты, рецепты, анализы и обследования.')),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: sheetTemplates }, 'Из шаблонов'), h('button', { class: 'btn primary', type: 'button', onclick: () => sheetEdit({ title: '', group: 'lab', intervalMonths: null, lastDone: null, unit: '', note: '' }) }, 'Добавить')),
    ),
    items.length
      ? GROUPS.map(group)
      : h('section', { class: 'card glass' }, h('p', { class: 'empty' }, 'Добавьте приём эндокринолога, анализы и врачей. Приложение посчитает следующую дату по тому, когда это было в последний раз, и напомнит заранее.')),
  );
}
