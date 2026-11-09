// Мелкие помощники интерфейса: создание элементов, значки, шторки, формы, уведомления.

export { fmtDate, plural, relDay, DAYS } from './logic.js';

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICONS = {
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  supplies: '<path d="M12 3s6 6.3 6 10.5a6 6 0 0 1-12 0C6 9.3 12 3 12 3z"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5"/>',
  health: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  sugar: '<path d="M4 19V5M4 19h16"/><path d="M7 15c2-6 4-6 5.5-2s3.5 3 6.500-5"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.500 4.500L19 7"/>',
  miss: '<path d="M7 7l10 10M17 7L7 17"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
};

export function icon(name, size = 22) {
  return h('span', {
    class: 'icon',
    'aria-hidden': 'true',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`,
  });
}

const numFmt = [0, 1, 2].map((d) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtNum = (n, digits = 0) => (n == null || isNaN(n) ? '–' : numFmt[digits].format(n));

const pad = (n) => String(n).padStart(2, '0');
/** Значение для поля datetime-local. */
export const dtLocal = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ---------- Шторка ----------

export function openSheet(title, ...content) {
  const root = document.getElementById('sheet-root');
  const prevFocus = document.activeElement;
  const close = () => {
    wrap.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => wrap.remove(), 220);
    prevFocus?.focus?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const wrap = h(
    'div',
    { class: 'sheet-wrap', onclick: (e) => e.target === wrap && close() },
    h(
      'section',
      { class: 'sheet glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', { class: 'sheet-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Закрыть', onclick: close }, icon('x'))),
      content,
    ),
  );
  root.append(wrap);
  document.addEventListener('keydown', onKey);
  void wrap.offsetWidth; // фиксируем начальное состояние, чтобы появление было плавным
  wrap.classList.add('open');
  wrap.querySelector('input:not([type=radio]):not([type=checkbox]), select, .sheet-body button')?.focus({ preventScroll: true });
  return close;
}

// ---------- Форма ----------

/**
 * fields: { name, label, type, value, hint, options, required, min, max, step, placeholder }
 * type: text | number | date | datetime-local | time | select | chips | checkbox | textarea | note
 */
export function form(fields, submitLabel, onSubmit) {
  const f = h('form', { class: 'form' });
  for (const fd of fields) {
    if (!fd) continue;
    if (fd.type === 'note') {
      f.append(h('p', { class: 'hint' }, fd.text));
      continue;
    }
    if (fd.type === 'checkbox') {
      f.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', name: fd.name, checked: !!fd.value }), h('span', {}, fd.label)));
      continue;
    }
    const id = 'f-' + fd.name;
    let input;
    if (fd.type === 'select') {
      input = h('select', { id, name: fd.name }, fd.options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(fd.value) }, l)));
    } else if (fd.type === 'chips') {
      input = h(
        'div',
        { class: 'chips', role: 'radiogroup', 'aria-label': fd.label },
        fd.options.map(([v, l, sub]) => h('label', { class: 'chip' }, h('input', { type: 'radio', name: fd.name, value: v, checked: v === fd.value }), h('span', {}, l, sub && h('small', {}, sub)))),
      );
    } else if (fd.type === 'textarea') {
      input = h('textarea', { id, name: fd.name, rows: 3, placeholder: fd.placeholder }, fd.value || '');
    } else {
      input = h('input', {
        id,
        name: fd.name,
        type: fd.type || 'text',
        value: fd.value ?? '',
        required: fd.required,
        min: fd.min,
        max: fd.max,
        step: fd.type === 'number' ? fd.step || 'any' : null,
        inputmode: fd.type === 'number' ? 'decimal' : null,
        placeholder: fd.placeholder,
        autocomplete: 'off',
      });
    }
    f.append(h('div', { class: 'field' }, h('label', { for: fd.type === 'chips' ? null : id }, fd.label), input, fd.hint && h('p', { class: 'hint' }, fd.hint)));
  }
  f.append(h('button', { class: 'btn primary wide', type: 'submit' }, submitLabel));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const out = {};
    for (const fd of fields) {
      if (!fd || !fd.name) continue;
      if (fd.type === 'chips') out[fd.name] = f.querySelector(`input[name="${fd.name}"]:checked`)?.value ?? '';
      else if (fd.type === 'checkbox') out[fd.name] = f.elements[fd.name].checked;
      else if (fd.type === 'number') out[fd.name] = f.elements[fd.name].value === '' ? null : Number(f.elements[fd.name].value);
      else out[fd.name] = f.elements[fd.name].value.trim();
    }
    onSubmit(out, f);
  });
  return f;
}

// ---------- Уведомление ----------

export function toast(message) {
  const root = document.getElementById('toast-root');
  const el = h('div', { class: 'toast glass' }, message);
  root.append(el);
  void el.offsetWidth;
  el.classList.add('open');
  setTimeout(() => {
    el.classList.remove('open');
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

/** Выбор файла и чтение его как текста. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept });
    input.onchange = async () => {
      const file = input.files[0];
      resolve(file ? { name: file.name, text: await file.text() } : null);
    };
    input.click();
  });
}

export function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
