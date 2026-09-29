'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const NUM1 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1, minimumFractionDigits: 0 });

function fmtSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '–';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${NUM1.format(v)} ${units[i]}`;
}

const fmtSpeed = (bps) => (bps > 0 ? `${fmtSize(Math.round(bps))}/s` : '–');

function fmtEta(sec) {
  if (sec == null || !Number.isFinite(sec)) return '–';
  sec = Math.round(sec);
  if (sec < 60) return `${sec} giây`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} phút ${String(sec % 60).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} giờ ${m % 60} phút`;
  return `${Math.floor(h / 24)} ngày`;
}

const pad2 = (n) => String(n).padStart(2, '0');
function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Accent-insensitive search: "tieu chi" matches "TIÊU CHÍ".
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ------------------------------------------------------------------ path helpers (renderer has no node:path)
const Paths = {
  win: false,
  sep: '/',
  init(platform) {
    this.win = platform === 'win32';
    this.sep = this.win ? '\\' : '/';
  },
  join(dir, name) {
    return dir.endsWith(this.sep) ? dir + name : dir + this.sep + name;
  },
  isRoot(p) {
    return this.win ? /^[A-Za-z]:\\?$/.test(p) : p === '/';
  },
  parent(p) {
    if (!p || this.isRoot(p)) return null;
    const trimmed = p.replace(/[\\/]+$/, '');
    const i = trimmed.lastIndexOf(this.sep);
    if (i < 0) return null;
    const up = trimmed.slice(0, i);
    if (this.win && /^[A-Za-z]:$/.test(up)) return `${up}\\`;
    return up || '/';
  },
  base(p) {
    const trimmed = p.replace(/[\\/]+$/, '');
    return trimmed.slice(trimmed.lastIndexOf(this.sep) + 1) || trimmed;
  },
  // "C:\Users\Lenovo" -> [{label:'C:', path:'C:\'}, {label:'Users', ...}, {label:'Lenovo', ...}]
  segments(p) {
    if (!p) return [];
    const out = [];
    if (this.win) {
      const parts = p.split('\\').filter(Boolean);
      let acc = '';
      parts.forEach((part, i) => {
        acc = i === 0 ? `${part}\\` : this.join(acc, part);
        out.push({ label: part, path: acc });
      });
    } else {
      out.push({ label: '/', path: '/' });
      let acc = '';
      for (const part of p.split('/').filter(Boolean)) {
        acc += `/${part}`;
        out.push({ label: part, path: acc });
      }
    }
    return out;
  },
};

// ------------------------------------------------------------------ toasts
function toast(message, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'cloud', 16)}<div>${esc(message)}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ------------------------------------------------------------------ modal helpers
function openModal(html, { narrow = false, onClose } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal${narrow ? ' narrow' : ''}" role="dialog">${html}</div>`;
  hydrateIcons(root);
  const modal = root.firstElementChild;
  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
    onClose && onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  root.onmousedown = (e) => {
    if (e.target === root) close();
  };
  for (const b of $$('[data-close]', modal)) b.onclick = close;
  return { modal, close };
}

function promptDialog({ title, label, value = '', ok = 'OK' }) {
  return new Promise((resolve) => {
    let result = null;
    const { modal, close } = openModal(
      `<div class="modal-head"><h3>${esc(title)}</h3></div>
       <div class="modal-body"><label class="field"><span>${esc(label)}</span><input class="input" id="pd-input" spellcheck="false" /></label></div>
       <div class="modal-foot"><div class="spacer"></div><button class="btn" data-close>Huỷ</button><button class="btn primary" id="pd-ok">${esc(ok)}</button></div>`,
      { narrow: true, onClose: () => resolve(result) },
    );
    const input = $('#pd-input', modal);
    input.value = value;
    input.focus();
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      result = v;
      close();
    };
    $('#pd-ok', modal).onclick = submit;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };
  });
}

function confirmDialog({ title, message, ok = 'Đồng ý', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const { modal, close } = openModal(
      `<div class="modal-head"><h3>${esc(title)}</h3></div>
       <div class="modal-body"><div>${esc(message)}</div></div>
       <div class="modal-foot"><div class="spacer"></div><button class="btn" data-close>Huỷ</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cd-ok">${esc(ok)}</button></div>`,
      { narrow: true, onClose: () => resolve(result) },
    );
    const okBtn = $('#cd-ok', modal);
    okBtn.focus();
    okBtn.onclick = () => {
      result = true;
      close();
    };
  });
}

// ------------------------------------------------------------------ context menu
function showMenu(x, y, items) {
  const menu = $('#menu');
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') {
      menu.appendChild(document.createElement('hr'));
      continue;
    }
    const b = document.createElement('button');
    if (it.danger) b.className = 'danger';
    b.disabled = Boolean(it.disabled);
    b.innerHTML = `${icon(it.icon || 'file', 15)}<span>${esc(it.label)}</span>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}`;
    b.onclick = () => {
      hideMenu();
      it.run();
    };
    menu.appendChild(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}
function hideMenu() {
  $('#menu').hidden = true;
}
