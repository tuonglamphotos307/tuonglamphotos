'use strict';

// A file list pane. Data access is delegated to an adapter (local disk or Google Drive).
const SORT_LABELS = { name: 'Tên', mtime: 'Ngày sửa', size: 'Dung lượng' };

let DRAG = null; // { from: Pane, items: [] } while dragging rows between panes

class Pane {
  constructor(el, adapter) {
    this.el = el;
    this.a = adapter;
    this.items = [];
    this.view = [];
    this.byKey = new Map();
    this.sel = new Set();
    this.anchor = null;
    this.sort = { key: 'name', dir: 1 };
    this.filter = '';
    this.loadSeq = 0;
    this.loading = false;
    this.error = null;

    this.list = $('.list', el);
    this.emptyEl = $('.pane-empty', el);
    this.searchInput = $('.search input', el);
    this.crumbList = $('.crumb-list', el);
    this.backBtn = $('.crumb-back', el);

    // hooks set by the app
    this.onTransfer = null; // (items) => void
    this.onDropItems = null; // (fromPane, items, targetItem|null) => void
    this.onDropFiles = null; // (paths, targetItem|null) => void
    this.onContext = null; // (event, items) => void
    this.onFocus = null;
    this.onNavigate = null;

    this._bind();
  }

  // ---------------------------------------------------------------- data

  async reload({ keepSelection = true } = {}) {
    const seq = ++this.loadSeq;
    const prevSel = keepSelection ? new Set(this.sel) : new Set();
    this.loading = true;
    this.error = null;
    this.renderChrome();
    if (!this.items.length) this.renderList();
    try {
      const items = await this.a.load();
      if (seq !== this.loadSeq) return;
      this.items = items;
      this.byKey = new Map(items.map((i) => [this.a.key(i), i]));
      this.sel = new Set([...prevSel].filter((k) => this.byKey.has(k)));
    } catch (err) {
      if (seq !== this.loadSeq) return;
      this.items = [];
      this.byKey = new Map();
      this.sel.clear();
      this.error = err;
    } finally {
      if (seq === this.loadSeq) {
        this.loading = false;
        this.render();
      }
    }
  }

  // Navigation: adapter changes location, then we reload and reset per-folder state.
  async navigated() {
    this.filter = '';
    this.searchInput.value = '';
    this.sel.clear();
    this.anchor = null;
    this.items = [];
    this.list.scrollTop = 0;
    this.onNavigate && this.onNavigate();
    await this.reload({ keepSelection: false });
  }

  computeView() {
    const f = fold(this.filter.trim());
    const { key, dir } = this.sort;
    const a = this.a;
    const view = f ? this.items.filter((i) => fold(a.label(i)).includes(f)) : this.items.slice();
    view.sort((x, y) => {
      const dx = a.isDir(x) ? 0 : 1;
      const dy = a.isDir(y) ? 0 : 1;
      if (dx !== dy) return dx - dy;
      let c = 0;
      if (key === 'mtime') c = (a.mtime(x) || 0) - (a.mtime(y) || 0);
      else if (key === 'size') c = (a.size(x) ?? -1) - (a.size(y) ?? -1);
      if (c === 0) c = collator.compare(a.label(x), a.label(y));
      return c * dir;
    });
    this.view = view;
  }

  selectedItems() {
    return this.view.filter((i) => this.sel.has(this.a.key(i)));
  }

  // ---------------------------------------------------------------- rendering

  render() {
    this.computeView();
    this.renderChrome();
    this.renderList();
    this.renderFooter();
  }

  renderChrome() {
    // crumbs
    const crumbs = this.a.crumbs();
    this.crumbList.innerHTML = '';
    crumbs.forEach((c, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.innerHTML = icon('chevronRight', 12);
        this.crumbList.appendChild(sep);
      }
      const b = document.createElement('button');
      b.className = `crumb${i === crumbs.length - 1 ? ' last' : ''}`;
      b.innerHTML = `${c.icon ? icon(c.icon, 13) : ''}<span>${esc(c.label)}</span>`;
      b.onclick = () => c.go && c.go();
      if (c.dropTarget) this._bindDropTarget(b, () => c.dropTarget);
      this.crumbList.appendChild(b);
    });
    this.crumbList.scrollLeft = this.crumbList.scrollWidth;
    this.backBtn.disabled = !this.a.canBack();

    // sort indicators
    for (const b of $$('.cols [data-sort]', this.el)) {
      const on = b.dataset.sort === this.sort.key;
      b.classList.toggle('on', on);
      b.textContent = SORT_LABELS[b.dataset.sort] + (on ? (this.sort.dir > 0 ? ' ↑' : ' ↓') : '');
    }
    $('.sort-btn .lbl', this.el).textContent = SORT_LABELS[this.sort.key];

    const canTransfer = this.a.canTransfer ? this.a.canTransfer() : true;
    $('[data-act="transfer"]', this.el).disabled = !canTransfer;
    const canMkdir = this.a.canMkdir ? this.a.canMkdir() : true;
    $('[data-act="mkdir"]', this.el).disabled = !canMkdir;
  }

  renderList() {
    const overlay = this.a.overlay && this.a.overlay();
    if (overlay) {
      this.list.innerHTML = '';
      this.emptyEl.hidden = false;
      this.emptyEl.innerHTML = overlay;
      hydrateIcons(this.emptyEl);
      this.a.bindOverlay && this.a.bindOverlay(this.emptyEl);
      return;
    }
    if (this.loading && !this.items.length) {
      this.list.innerHTML = '';
      this.emptyEl.hidden = false;
      this.emptyEl.innerHTML = '<div class="spinner"></div>';
      return;
    }
    if (this.error) {
      this.list.innerHTML = '';
      this.emptyEl.hidden = false;
      this.emptyEl.innerHTML = `<div class="empty-card">${icon('alert', 28, 'style="color:var(--danger)"')}<p>${esc(this.error.message)}</p><button class="btn small" id="retry-${this.a.name}">Thử lại</button></div>`;
      $(`#retry-${this.a.name}`, this.emptyEl).onclick = () => this.reload();
      return;
    }
    if (!this.view.length) {
      this.list.innerHTML = '';
      this.emptyEl.hidden = false;
      this.emptyEl.innerHTML = `<div class="empty-card"><small>${this.filter ? 'Không có mục nào khớp tìm kiếm.' : 'Thư mục trống.'}</small></div>`;
      return;
    }
    this.emptyEl.hidden = true;

    const a = this.a;
    const html = this.view
      .map((it) => {
        const k = a.key(it);
        const dir = a.isDir(it);
        return `<div class="row${this.sel.has(k) ? ' sel' : ''}${a.dim && a.dim(it) ? ' dim' : ''}" data-k="${esc(k)}" draggable="true">
          <span class="ic">${typeIcon(a.type(it), 18)}</span>
          <span class="nm" title="${esc(a.label(it))}">${esc(a.label(it))}</span>
          <span class="chev">${dir ? icon('chevronRight', 14) : ''}</span>
          <span class="dt">${fmtDate(a.mtime(it))}</span>
          <span class="sz">${dir ? '–' : fmtSize(a.size(it))}</span>
        </div>`;
      })
      .join('');
    this.list.innerHTML = html;
  }

  renderSelection() {
    for (const row of this.list.children) row.classList.toggle('sel', this.sel.has(row.dataset.k));
    this.renderFooter();
  }

  renderFooter() {
    const sel = this.selectedItems();
    const selSize = sel.reduce((s, i) => s + (this.a.isDir(i) ? 0 : this.a.size(i) || 0), 0);
    const left = sel.length
      ? `${sel.length} mục đã chọn: ${fmtSize(selSize)}`
      : `${this.view.length} mục${this.filter ? ` (lọc từ ${this.items.length})` : ''}`;
    $('.foot-left', this.el).textContent = this.a.overlay && this.a.overlay() ? '–' : left;
    Promise.resolve(this.a.footerRight ? this.a.footerRight() : '').then((t) => {
      $('.foot-right', this.el).textContent = t || '';
    });
  }

  // ---------------------------------------------------------------- selection

  _rowKey(target) {
    const row = target.closest('.row');
    return row ? row.dataset.k : null;
  }

  selectOnly(k) {
    this.sel = new Set(k ? [k] : []);
    this.anchor = k;
    this.renderSelection();
  }

  clickSelect(k, e) {
    if (e.shiftKey && this.anchor) {
      const keys = this.view.map((i) => this.a.key(i));
      const [a, b] = [keys.indexOf(this.anchor), keys.indexOf(k)].sort((x, y) => x - y);
      if (a >= 0) {
        if (!(e.ctrlKey || e.metaKey)) this.sel.clear();
        for (let i = a; i <= b; i++) this.sel.add(keys[i]);
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (this.sel.has(k)) this.sel.delete(k);
      else this.sel.add(k);
      this.anchor = k;
    } else {
      this.sel = new Set([k]);
      this.anchor = k;
    }
    this.renderSelection();
  }

  moveCursor(delta, extend) {
    if (!this.view.length) return;
    const keys = this.view.map((i) => this.a.key(i));
    let idx = this.anchor ? keys.indexOf(this.anchor) : -1;
    idx = Math.max(0, Math.min(keys.length - 1, idx + delta));
    const k = keys[idx];
    if (extend) {
      this.sel.add(k);
      this.anchor = k;
      this.renderSelection();
    } else this.selectOnly(k);
    const row = this.list.querySelector(`.row[data-k="${CSS.escape(k)}"]`);
    row && row.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- events

  _bind() {
    const el = this.el;
    el.addEventListener('mousedown', () => this.onFocus && this.onFocus(this));
    el.addEventListener('focusin', () => this.onFocus && this.onFocus(this));

    this.list.addEventListener('mousedown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      const k = this._rowKey(e.target);
      if (!k) {
        if (e.button === 0 && !e.ctrlKey && !e.shiftKey) this.selectOnly(null);
        return;
      }
      if (e.button === 2 && this.sel.has(k)) return;
      // Keep a multi-selection when starting a drag from one of its rows.
      if (e.button === 0 && this.sel.has(k) && !e.ctrlKey && !e.shiftKey && this.sel.size > 1) {
        this._pendingSelect = k;
        return;
      }
      this.clickSelect(k, e);
    });
    this.list.addEventListener('click', (e) => {
      const k = this._rowKey(e.target);
      if (this._pendingSelect && k === this._pendingSelect) this.selectOnly(k);
      this._pendingSelect = null;
    });
    this.list.addEventListener('dblclick', (e) => {
      const k = this._rowKey(e.target);
      const item = k && this.byKey.get(k);
      if (item) this.a.open(item);
    });
    this.list.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const k = this._rowKey(e.target);
      if (k && !this.sel.has(k)) this.selectOnly(k);
      this.onContext && this.onContext(e, k ? this.selectedItems() : []);
    });

    el.addEventListener('keydown', (e) => {
      if (e.target === this.searchInput) {
        if (e.key === 'Escape') {
          this.searchInput.value = '';
          this.filter = '';
          this.render();
          this.list.focus();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.list.focus();
          this.moveCursor(1, false);
        }
        return;
      }
      if (e.target.tagName === 'INPUT') return;
      const sel = this.selectedItems();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveCursor(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
      } else if (e.key === 'Enter' && sel.length === 1) {
        this.a.open(sel[0]);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        this.a.up();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.sel = new Set(this.view.map((i) => this.a.key(i)));
        this.renderSelection();
      } else if (e.key === 'F5') {
        e.preventDefault();
        this.reload();
      } else if (e.key === 'F2' && sel.length === 1 && this.a.rename) {
        this.a.rename(sel[0]);
      } else if (e.key === 'Delete' && sel.length && this.a.remove) {
        this.a.remove(sel);
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
        // Type-to-search
        this.searchInput.focus();
      }
    });

    this.searchInput.addEventListener('input', () => {
      this.filter = this.searchInput.value;
      this.computeView();
      this.renderList();
      this.renderFooter();
    });

    for (const b of $$('.cols [data-sort]', el)) {
      b.onclick = () => this.setSort(b.dataset.sort);
    }
    $('[data-act="sort"]', el).onclick = () => {
      const keys = ['name', 'mtime', 'size'];
      const key = keys[(keys.indexOf(this.sort.key) + 1) % keys.length];
      this.sort = { key, dir: key === 'name' ? 1 : -1 };
      this.render();
    };
    $('[data-act="refresh"]', el).onclick = () => this.reload();
    $('[data-act="back"]', el).onclick = () => this.a.back();
    $('[data-act="mkdir"]', el).onclick = () => this.a.mkdir && this.a.mkdir();
    $('[data-act="transfer"]', el).onclick = () => {
      const items = this.selectedItems();
      if (!items.length) {
        toast('Chọn ít nhất một file hoặc thư mục trước đã.');
        return;
      }
      this.onTransfer && this.onTransfer(items);
    };
    el.addEventListener('mouseup', (e) => {
      if (e.button === 3) this.a.back(); // mouse "back" button
    });

    // ---- drag source
    this.list.addEventListener('dragstart', (e) => {
      const k = this._rowKey(e.target);
      if (!k) return;
      if (!this.sel.has(k)) this.selectOnly(k);
      this._pendingSelect = null;
      DRAG = { from: this, items: this.selectedItems() };
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-drivedock', this.a.name);
    });
    this.list.addEventListener('dragend', () => {
      DRAG = null;
      this._clearDrop();
    });

    // ---- drop target (whole list + folder rows)
    const accepts = (e) => {
      if (DRAG && DRAG.from !== this) return true;
      return this.a.acceptsOsFiles && e.dataTransfer.types.includes('Files') && !DRAG;
    };
    this.list.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const k = this._rowKey(e.target);
      const item = k && this.byKey.get(k);
      const folderRow = item && this.a.isDir(item) ? e.target.closest('.row') : null;
      if (this._dropRow !== folderRow) {
        this._dropRow && this._dropRow.classList.remove('drop');
        this._dropRow = folderRow;
        folderRow && folderRow.classList.add('drop');
      }
      this.el.classList.toggle('dropping', !folderRow);
    });
    this.list.addEventListener('dragleave', (e) => {
      if (!this.list.contains(e.relatedTarget)) this._clearDrop();
    });
    this.list.addEventListener('drop', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      const k = this._dropRow ? this._dropRow.dataset.k : null;
      const target = k ? this.byKey.get(k) : null;
      this._clearDrop();
      this._handleDrop(e, target);
    });
  }

  _bindDropTarget(el, getTarget) {
    el.addEventListener('dragover', (e) => {
      if (DRAG && DRAG.from !== this) {
        e.preventDefault();
        el.classList.add('drop');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop');
      if (!DRAG || DRAG.from === this) return;
      e.preventDefault();
      this._handleDrop(e, getTarget());
    });
  }

  _handleDrop(e, target) {
    if (DRAG && DRAG.from !== this) {
      const { from, items } = DRAG;
      DRAG = null;
      this.onDropItems && this.onDropItems(from, items, target);
    } else if (e.dataTransfer.files.length && this.a.acceptsOsFiles) {
      const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
      if (paths.length) this.onDropFiles && this.onDropFiles(paths, target);
    }
  }

  _clearDrop() {
    this._dropRow && this._dropRow.classList.remove('drop');
    this._dropRow = null;
    this.el.classList.remove('dropping');
  }

  setSort(key) {
    this.sort = this.sort.key === key ? { key, dir: -this.sort.dir } : { key, dir: key === 'name' ? 1 : -1 };
    this.render();
  }
}
