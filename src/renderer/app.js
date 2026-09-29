'use strict';

// `api` is the global exposed by preload.js (contextBridge).
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

const S = {
  info: null,
  settings: null,
  auth: { loggedIn: false, user: null, configured: false },
  quota: null,
};

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // storage unavailable: ignore
    }
  },
};

// ======================================================================= local pane

const localState = { path: null, history: [] };

const localAdapter = {
  name: 'local',
  acceptsOsFiles: false,
  key: (i) => i.path,
  isDir: (i) => i.isDir,
  label: (i) => i.name,
  mtime: (i) => i.mtime,
  size: (i) => i.size,
  type: (i) => (i.isRoot ? 'disk' : fileType({ name: i.name, isDir: i.isDir })),
  dim: (i) => i.unreadable,
  async load() {
    if (!localState.path) {
      const roots = await api.local.roots();
      return roots.map((r) => ({ name: r.name, path: r.path, isDir: true, isRoot: true, size: null, mtime: null }));
    }
    return api.local.list(localState.path);
  },
  crumbs() {
    const out = [{ label: 'Máy tính', icon: 'laptop', go: () => goLocal(null) }];
    for (const s of Paths.segments(localState.path)) {
      out.push({ label: s.label, go: () => goLocal(s.path), dropTarget: { path: s.path, isDir: true } });
    }
    return out;
  },
  canBack: () => localState.history.length > 0,
  back() {
    if (!localState.history.length) return;
    goLocal(localState.history.pop(), { push: false });
  },
  up() {
    if (localState.path) goLocal(Paths.parent(localState.path));
  },
  open(item) {
    if (item.isDir) goLocal(item.path);
    else api.local.open(item.path).catch((e) => toast(e.message, 'error'));
  },
  canTransfer: () => Boolean(localState.path),
  canMkdir: () => Boolean(localState.path),
  async mkdir() {
    const name = await promptDialog({ title: 'Thư mục mới', label: 'Tên thư mục', value: 'Thư mục mới', ok: 'Tạo' });
    if (!name) return;
    try {
      const p = await api.local.mkdir(localState.path, name);
      await paneLocal.reload();
      paneLocal.selectOnly(p);
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  async rename(item) {
    if (item.isRoot) return;
    const name = await promptDialog({ title: 'Đổi tên', label: 'Tên mới', value: item.name, ok: 'Đổi tên' });
    if (!name || name === item.name) return;
    try {
      const p = await api.local.rename(item.path, name);
      await paneLocal.reload();
      paneLocal.selectOnly(p);
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  async remove(items) {
    items = items.filter((i) => !i.isRoot);
    if (!items.length) return;
    const ok = await confirmDialog({
      title: 'Xoá vào Thùng rác',
      message: items.length === 1 ? `Chuyển "${items[0].name}" vào Thùng rác?` : `Chuyển ${items.length} mục vào Thùng rác?`,
      ok: 'Xoá',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.local.trash(items.map((i) => i.path));
    } catch (e) {
      toast(e.message, 'error');
    }
    paneLocal.reload();
  },
  async footerRight() {
    if (!localState.path) return '';
    const free = await api.local.freeSpace(localState.path).catch(() => null);
    return free == null ? '' : `${fmtSize(free)} trống`;
  },
};

function goLocal(p, { push = true } = {}) {
  if (push && localState.path !== p) localState.history.push(localState.path);
  if (localState.history.length > 100) localState.history.shift();
  localState.path = p;
  store.set('localPath', p);
  highlightNav();
  paneLocal.navigated();
}

// ======================================================================= drive pane

const DRIVE_PLACES = {
  root: { id: 'root', name: 'Drive của tôi', icon: 'hdd' },
  shared: { id: 'shared', name: 'Được chia sẻ', icon: 'users' },
  drives: { id: 'drives', name: 'Bộ nhớ dùng chung', icon: 'building' },
};

const driveState = { stack: [DRIVE_PLACES.root], history: [] };
const driveCur = () => driveState.stack[driveState.stack.length - 1];
const isRealFolder = (loc) => loc && loc.id !== 'shared' && loc.id !== 'drives';

const isDriveDir = (i) => i.mimeType === FOLDER_MIME || (i.mimeType === SHORTCUT_MIME && i.shortcutDetails?.targetMimeType === FOLDER_MIME);

// Location object for navigating into / uploading into a Drive folder item.
function driveLoc(item) {
  const cur = driveCur();
  if (item.mimeType === SHORTCUT_MIME) {
    return { id: item.shortcutDetails.targetId, name: item.name, resourceKey: item.shortcutDetails.targetResourceKey || null, driveId: null };
  }
  return {
    id: item.id,
    name: item.name,
    resourceKey: item.resourceKey || null,
    driveId: item.driveId || (item.isSharedDrive ? item.id : cur.driveId) || null,
    icon: item.isSharedDrive ? 'building' : null,
  };
}

const driveAdapter = {
  name: 'drive',
  acceptsOsFiles: true,
  key: (i) => i.id,
  isDir: isDriveDir,
  label: (i) => i.name,
  mtime: (i) => (i.modifiedTime ? Date.parse(i.modifiedTime) : null),
  size: (i) => (i.size != null ? Number(i.size) : null),
  type: (i) => (i.isSharedDrive ? 'sharedDrive' : fileType({ name: i.name, mimeType: i.mimeType, isDir: isDriveDir(i) })),
  async load() {
    if (!S.auth.loggedIn) return [];
    const cur = driveCur();
    return api.drive.list({ id: cur.id, driveId: cur.driveId, resourceKey: cur.resourceKey });
  },
  overlay() {
    if (S.auth.loggedIn) return null;
    return `<div class="empty-card">
      <div class="empty-art"><i></i><i></i><i></i></div>
      <h3>Đưa Drive của anh vào đây</h3>
      <p>Đăng nhập một lần để duyệt thư mục, kéo thả để tải lên, và tải cả thư mục về máy.</p>
      <button class="btn accent" id="btn-connect"><span data-icon="cloud"></span>Kết nối Google Drive</button>
      <small>Mở trình duyệt để đăng nhập an toàn với Google.<br />File công khai thì chỉ cần dán link ở thanh trên cùng.</small>
    </div>`;
  },
  bindOverlay(el) {
    const b = $('#btn-connect', el);
    if (b) b.onclick = () => connect(b);
  },
  crumbs() {
    return driveState.stack.map((s, i) => ({
      label: s.name,
      icon: i === 0 ? s.icon || 'folder' : s.icon,
      go: () => goDrive(driveState.stack.slice(0, i + 1)),
      dropTarget: isRealFolder(s) ? { ...s, __loc: true } : null,
    }));
  },
  canBack: () => driveState.history.length > 0,
  back() {
    if (!driveState.history.length) return;
    goDrive(driveState.history.pop(), { push: false });
  },
  up() {
    if (driveState.stack.length > 1) goDrive(driveState.stack.slice(0, -1));
  },
  open(item) {
    if (isDriveDir(item)) goDrive([...driveState.stack, driveLoc(item)]);
    else if (item.webViewLink) api.openExternal(item.webViewLink);
  },
  canTransfer: () => S.auth.loggedIn,
  canMkdir: () => S.auth.loggedIn && isRealFolder(driveCur()),
  async mkdir() {
    const name = await promptDialog({ title: 'Thư mục mới trên Drive', label: 'Tên thư mục', value: 'Thư mục mới', ok: 'Tạo' });
    if (!name) return;
    try {
      const f = await api.drive.mkdir(driveCur().id, name);
      await paneDrive.reload();
      paneDrive.selectOnly(f.id);
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  async rename(item) {
    if (item.isSharedDrive) return;
    const name = await promptDialog({ title: 'Đổi tên trên Drive', label: 'Tên mới', value: item.name, ok: 'Đổi tên' });
    if (!name || name === item.name) return;
    try {
      await api.drive.rename(item.id, name);
      paneDrive.reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  async remove(items) {
    items = items.filter((i) => !i.isSharedDrive);
    if (!items.length) return;
    const ok = await confirmDialog({
      title: 'Chuyển vào thùng rác Drive',
      message: items.length === 1 ? `Chuyển "${items[0].name}" vào thùng rác Google Drive?` : `Chuyển ${items.length} mục vào thùng rác Google Drive?`,
      ok: 'Chuyển vào thùng rác',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.drive.trash(items.map((i) => i.id));
      toast('Đã chuyển vào thùng rác. Có thể khôi phục trên drive.google.com trong 30 ngày.', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
    paneDrive.reload();
  },
  footerRight() {
    if (!S.auth.loggedIn || !S.quota) return '';
    const used = Number(S.quota.usage || 0);
    const limit = S.quota.limit ? Number(S.quota.limit) : null;
    return limit ? `Đã dùng ${fmtSize(used)} / ${fmtSize(limit)}` : `Đã dùng ${fmtSize(used)}`;
  },
};

function goDrive(stack, { push = true } = {}) {
  if (push) driveState.history.push(driveState.stack);
  if (driveState.history.length > 100) driveState.history.shift();
  driveState.stack = stack;
  highlightNav();
  paneDrive.navigated();
}

// ======================================================================= transfers

async function downloadItems(items, destDir) {
  if (!destDir) {
    toast('Hãy mở một thư mục ở khung "Máy của anh" để làm nơi lưu.', 'error');
    return;
  }
  if (!S.auth.loggedIn) {
    toast('Hãy kết nối Google Drive trước.', 'error');
    return;
  }
  // A shared drive downloads like a folder whose id is also its driveId.
  const plain = items.map((i) => (i.isSharedDrive ? { ...i, mimeType: FOLDER_MIME, driveId: i.id } : i));
  try {
    const n = await api.transfer.download(plain, destDir);
    toast(`Đã thêm ${n} mục vào hàng đợi tải xuống.`, 'ok');
    expandQueue();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function driveLabel(stack) {
  return stack.map((s) => s.name).join('/');
}

async function uploadPaths(paths, loc, labelStack) {
  if (!S.auth.loggedIn) {
    toast('Hãy kết nối Google Drive trước khi tải lên.', 'error');
    return;
  }
  if (!isRealFolder(loc)) {
    toast('Hãy mở một thư mục trong Drive (không phải danh sách "Được chia sẻ" / "Bộ nhớ dùng chung") để tải lên.', 'error');
    return;
  }
  const parent = { id: loc.id, driveId: loc.driveId || null, label: driveLabel(labelStack) };
  try {
    const n = await api.transfer.upload(paths, parent);
    toast(`Đã thêm ${n} mục vào hàng đợi tải lên.`, 'ok');
    expandQueue();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// Upload target for a drop onto a folder row / crumb in the Drive pane (or the current folder).
function driveDropTarget(target) {
  if (!target) return { loc: driveCur(), stack: driveState.stack };
  if (target.__loc) {
    const idx = driveState.stack.findIndex((s) => s.id === target.id);
    return { loc: target, stack: driveState.stack.slice(0, idx + 1) };
  }
  const loc = driveLoc(target);
  return { loc, stack: [...driveState.stack, loc] };
}

// ======================================================================= queue panel

const Q = { tasks: new Map(), order: [], rows: new Map(), filter: 'all', stats: {} };

const STATUS_LABEL = {
  queued: 'Đang chờ',
  running: 'Đang chạy',
  paused: 'Tạm dừng',
  done: 'Hoàn tất',
  skipped: 'Bỏ qua',
  error: 'Lỗi',
  canceled: 'Đã huỷ',
};

function statusText(t) {
  if (t.isFolder && t.status === 'running') return 'Đang quét';
  if (t.isFolder && t.status === 'done') return 'Đã quét';
  if (t.status === 'running') return t.type === 'upload' ? 'Đang tải lên' : 'Đang tải xuống';
  if (t.status === 'queued' && t.note && t.note.startsWith('Thử lại')) return 'Chờ thử lại';
  return STATUS_LABEL[t.status] || t.status;
}

function qMatches(t) {
  switch (Q.filter) {
    case 'active': return t.status === 'queued' || t.status === 'running' || t.status === 'paused';
    case 'error': return t.status === 'error';
    case 'done': return t.status === 'done' || t.status === 'skipped' || t.status === 'canceled';
    default: return true;
  }
}

function qActions(t) {
  const b = (a, ic, title) => `<button data-a="${a}" data-id="${t.id}" title="${title}">${icon(ic, 14)}</button>`;
  switch (t.status) {
    case 'queued':
    case 'running': return b('pause', 'pause', 'Tạm dừng') + b('cancel', 'x', 'Huỷ');
    case 'paused': return b('resume', 'play', 'Tiếp tục') + b('cancel', 'x', 'Huỷ');
    case 'error': return b('retry', 'retry', 'Thử lại') + b('remove', 'trash', 'Xoá khỏi danh sách');
    case 'canceled':
    case 'skipped': return b('retry', 'retry', 'Chạy lại') + b('remove', 'trash', 'Xoá khỏi danh sách');
    case 'done':
      return (t.type === 'download' && t.localPath && !t.isFolder ? b('reveal', 'eye', 'Mở thư mục chứa') : '') + b('remove', 'trash', 'Xoá khỏi danh sách');
    default: return '';
  }
}

function qRow(t) {
  let row = Q.rows.get(t.id);
  if (!row) {
    row = document.createElement('div');
    row.className = 'q-row';
    row.innerHTML = `<span class="dir"></span>
      <div class="src"></div>
      <div class="dst"></div>
      <div class="st"><span class="pill"></span><small></small></div>
      <div class="num size"></div>
      <div class="bar"><div class="track"><div class="fill"></div></div><span class="pct"></span></div>
      <div class="num speed"></div>
      <div class="num eta"></div>
      <div class="acts"></div>`;
    row._ = {
      acts: $('.acts', row), dir: $('.dir', row), src: $('.src', row), dst: $('.dst', row),
      pill: $('.pill', row), note: $('.st small', row), size: $('.size', row),
      fill: $('.fill', row), pct: $('.pct', row), speed: $('.speed', row), eta: $('.eta', row),
    };
    Q.rows.set(t.id, row);
  }
  const r = row._;
  if (row.dataset.status !== t.status || row.dataset.lp !== String(Boolean(t.localPath))) {
    row.dataset.status = t.status;
    row.dataset.lp = String(Boolean(t.localPath));
    r.acts.innerHTML = qActions(t);
  }
  if (row.dataset.type !== t.type) {
    row.dataset.type = t.type;
    r.dir.className = `dir ${t.type === 'upload' ? 'up' : 'down'}`;
    r.dir.innerHTML = icon(t.type === 'upload' ? 'arrowUp' : 'arrowDown', 14);
    r.dir.title = t.type === 'upload' ? 'Tải lên Drive' : 'Tải về máy';
  }
  const src = t.source || t.name || '';
  r.src.textContent = t.isFolder ? `${src}/` : src;
  r.src.title = src;
  r.dst.textContent = t.dest || '';
  r.dst.title = t.dest || '';
  r.pill.className = `pill ${t.status}`;
  r.pill.textContent = statusText(t);
  const note = t.error || t.note || '';
  r.note.textContent = note;
  r.note.title = note;
  r.note.hidden = !note;

  r.size.textContent = t.isFolder ? '–' : fmtSize(t.size);
  let pct = null;
  if (t.status === 'done' || t.status === 'skipped') pct = 100;
  else if (t.size > 0) pct = Math.min(100, (t.transferred / t.size) * 100);
  const indet = t.status === 'running' && (t.isFolder || pct == null);
  r.fill.classList.toggle('indet', indet);
  r.fill.classList.toggle('done', t.status === 'done');
  r.fill.classList.toggle('error', t.status === 'error');
  r.fill.classList.toggle('paused', t.status === 'paused');
  r.fill.style.width = `${pct ?? 0}%`;
  r.pct.textContent = indet ? (t.transferred ? fmtSize(t.transferred) : '') : pct == null ? '' : `${Math.floor(pct)}%`;
  r.speed.textContent = t.status === 'running' && !t.isFolder ? fmtSpeed(t.speed) : '–';
  r.eta.textContent = t.status === 'running' && !t.isFolder ? fmtEta(t.eta) : '–';
  row.hidden = !qMatches(t);
  return row;
}

function qRenderOrder() {
  const body = $('#q-body');
  body.replaceChildren(...Q.order.map((id) => Q.rows.get(id)).filter(Boolean));
  qRenderEmpty();
}

function qRenderEmpty() {
  const anyVisible = Q.order.some((id) => {
    const t = Q.tasks.get(id);
    return t && qMatches(t);
  });
  $('#q-empty').hidden = anyVisible;
  $('#q-body').hidden = !anyVisible;
}

function qRenderStats(stats) {
  Q.stats = stats || Q.stats;
  const s = Q.stats;
  const parts = [];
  if (s.running) parts.push(`${s.running} đang chạy`);
  if (s.queued) parts.push(`${s.queued} chờ`);
  if (s.errors) parts.push(`${s.errors} lỗi`);
  if (s.speed) parts.push(fmtSpeed(s.speed));
  $('#q-summary').textContent = parts.join(' · ');
  const badge = $('#queue-badge');
  const n = (s.running || 0) + (s.queued || 0);
  badge.hidden = !n;
  badge.textContent = n;
  document.title = s.running && s.speed ? `DriveDock — ${fmtSpeed(s.speed)}` : 'DriveDock';
  $('#live').hidden = !s.running;
  $('#live-speed').textContent = s.speed ? `${fmtSpeed(s.speed)} · ${s.running} file` : `${s.running} file đang chạy`;
}

const refreshLocalSoon = debounce(() => paneLocal.reload(), 800);
const refreshDriveSoon = debounce(() => paneDrive.reload(), 1200);

function qApply(update) {
  let reorder = false;
  for (const t of update.changed) {
    const prev = Q.tasks.get(t.id);
    if (!prev) reorder = true;
    Q.tasks.set(t.id, t);
    qRow(t);
    if (t.status === 'done' && (!prev || prev.status !== 'done')) {
      if (t.type === 'download' && localState.path && (t.dest || '').startsWith(localState.path)) refreshLocalSoon();
      if (t.type === 'upload' && S.auth.loggedIn) refreshDriveSoon();
    }
  }
  for (const id of update.removed || []) {
    Q.tasks.delete(id);
    Q.rows.get(id)?.remove();
    Q.rows.delete(id);
  }
  if (update.order && (reorder || update.order.length !== Q.order.length)) {
    Q.order = update.order;
    qRenderOrder();
  } else {
    qRenderEmpty();
  }
  qRenderStats(update.stats);
}

function bindQueue() {
  $('#q-body').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const { a, id } = b.dataset;
    const t = Q.tasks.get(id);
    if (a === 'reveal') {
      if (t && t.localPath) api.local.reveal(t.localPath);
      return;
    }
    api.queue.action(a, [id]).catch((err) => toast(err.message, 'error'));
  });
  $('#q-body').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.q-row');
    if (!row) return;
    const id = [...Q.rows].find(([, r]) => r === row)?.[0];
    const t = id && Q.tasks.get(id);
    if (t && t.status === 'done' && t.localPath) api.local.reveal(t.localPath);
  });
  for (const b of $$('.queue-head [data-q]')) {
    b.onclick = async () => {
      const action = b.dataset.q;
      if (action === 'cancel') {
        const active = [...Q.tasks.values()].filter((t) => ['queued', 'running', 'paused', 'error'].includes(t.status)).length;
        if (!active) return;
        const ok = await confirmDialog({ title: 'Huỷ tất cả', message: `Huỷ ${active} tiến trình chưa xong? File tải dở sẽ bị xoá.`, ok: 'Huỷ tất cả', danger: true });
        if (!ok) return;
      }
      api.queue.action(action).catch((err) => toast(err.message, 'error'));
    };
  }
  for (const b of $$('#q-filters button')) {
    b.onclick = () => {
      Q.filter = b.dataset.f;
      $$('#q-filters button').forEach((x) => x.classList.toggle('on', x === b));
      for (const [id, row] of Q.rows) row.hidden = !qMatches(Q.tasks.get(id));
      qRenderEmpty();
    };
  }
  $('#q-collapse').onclick = () => setQueueCollapsed(!$('#main').classList.contains('queue-collapsed'));
  $('#nav-queue').onclick = () => {
    expandQueue();
    const q = $('#queue');
    q.animate([{ borderColor: 'var(--accent)' }, { borderColor: 'var(--line)' }], { duration: 900 });
  };
  const auto = $('#auto-resume');
  auto.checked = Boolean(S.settings.autoResume);
  auto.onchange = async () => {
    S.settings = await api.settings.set({ autoResume: auto.checked });
  };
  api.queue.onUpdate(qApply);
}

function setQueueCollapsed(collapsed) {
  $('#main').classList.toggle('queue-collapsed', collapsed);
  store.set('queueCollapsed', collapsed);
}
function expandQueue() {
  setQueueCollapsed(false);
}

// ======================================================================= link download dialog

function openLinkModal(prefill = '') {
  let results = [];
  let seq = 0;
  const initialDest = store.get('lastDest', null) || S.settings.defaultDownloadDir || localState.path || S.info.paths.downloads;

  const { modal, close } = openModal(`
    <div class="modal-head">
      <span class="pane-icon drive" data-icon="link"></span>
      <div><h3>Tải từ link Google Drive</h3><p>Dán một hoặc nhiều link file / thư mục (mỗi link một dòng). Hỗ trợ link chia sẻ, Docs/Sheets/Slides và ID.</p></div>
    </div>
    <div class="modal-body">
      <textarea class="input" id="lk-text" placeholder="https://drive.google.com/drive/folders/…&#10;https://drive.google.com/file/d/…/view?usp=sharing" spellcheck="false"></textarea>
      <div class="resolved" id="lk-res"></div>
      <label class="field"><span>Lưu vào</span>
        <div class="inline">
          <input class="input" id="lk-dest" spellcheck="false" />
          <button class="btn" id="lk-pick">Chọn…</button>
          ${localState.path ? '<button class="btn" id="lk-here" title="Dùng thư mục đang mở ở khung Máy của anh">Thư mục đang mở</button>' : ''}
        </div>
      </label>
    </div>
    <div class="modal-foot">
      <small id="lk-note" style="color:var(--muted)"></small>
      <div class="spacer"></div>
      <button class="btn" data-close>Huỷ</button>
      <button class="btn" id="lk-browse" hidden><span data-icon="folder"></span>Mở trong khung Drive</button>
      <button class="btn primary" id="lk-go" disabled><span data-icon="download"></span>Tải xuống</button>
    </div>`);

  const text = $('#lk-text', modal);
  const res = $('#lk-res', modal);
  const dest = $('#lk-dest', modal);
  const go = $('#lk-go', modal);
  const browse = $('#lk-browse', modal);
  const note = $('#lk-note', modal);
  dest.value = initialDest;
  note.textContent = S.auth.loggedIn ? '' : 'Chưa kết nối Drive: chỉ tải được file công khai.';

  const renderResults = () => {
    res.innerHTML = results
      .map((r, i) => {
        if (!r.ok) {
          const needLogin = !S.auth.loggedIn && (r.code === 'NEED_LOGIN' || /chia sẻ công khai|không tồn tại/i.test(r.error));
          return `<div class="res-item bad">${icon('alert', 18, 'style="color:var(--danger)"')}
            <div style="min-width:0"><div class="nm">${esc(r.input)}</div><div class="meta">${esc(r.error)}</div></div>
            ${needLogin ? `<button class="btn small" data-login="${i}">Kết nối Drive</button>` : ''}</div>`;
        }
        const it = r.item;
        const type = it.isFolder ? 'folder' : fileType({ name: it.name, mimeType: it.mimeType });
        const meta = [
          it.isFolder ? 'Thư mục — tải toàn bộ bên trong' : it.size != null ? fmtSize(Number(it.size)) : it.mimeType?.startsWith('application/vnd.google-apps') ? 'Google Docs — sẽ xuất sang Office' : '',
          it.public ? 'công khai, không cần đăng nhập' : '',
        ].filter(Boolean).join(' · ');
        return `<div class="res-item">${typeTile(type, 18)}<div style="min-width:0"><div class="nm" title="${esc(it.name)}">${esc(it.name)}</div><div class="meta">${esc(meta)}</div></div><span class="tag">${icon('check', 16)}</span></div>`;
      })
      .join('');
    for (const b of $$('[data-login]', res)) b.onclick = () => connect(b).then(() => resolveNow());
    const ok = results.filter((r) => r.ok);
    go.disabled = !ok.length;
    go.innerHTML = `${icon('download', 16)}Tải xuống${ok.length > 1 ? ` (${ok.length})` : ''}`;
    browse.hidden = !(ok.length === 1 && ok[0].item.isFolder && S.auth.loggedIn);
  };

  const resolveNow = async () => {
    const my = ++seq;
    const value = text.value.trim();
    if (!value) {
      results = [];
      renderResults();
      return;
    }
    go.disabled = true;
    res.innerHTML = '<div class="res-item"><div class="spinner" style="width:18px;height:18px"></div><div class="meta">Đang kiểm tra link…</div><span></span></div>';
    try {
      const out = await api.links.resolve(value);
      if (my !== seq) return;
      results = out.length ? out : [{ ok: false, input: value.slice(0, 80), error: 'Không nhận ra link Google Drive nào.' }];
    } catch (e) {
      if (my !== seq) return;
      results = [{ ok: false, input: value.slice(0, 80), error: e.message }];
    }
    renderResults();
  };
  const resolveSoon = debounce(resolveNow, 450);

  text.addEventListener('input', resolveSoon);
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !go.disabled) go.click();
  });
  $('#lk-pick', modal).onclick = async () => {
    const p = await api.pickFolder(dest.value || undefined);
    if (p) dest.value = p;
  };
  const here = $('#lk-here', modal);
  if (here) here.onclick = () => (dest.value = localState.path);

  go.onclick = async () => {
    const items = results.filter((r) => r.ok).map((r) => r.item);
    const target = dest.value.trim();
    if (!target) {
      toast('Chọn thư mục lưu trước đã.', 'error');
      return;
    }
    try {
      const n = await api.transfer.download(items, target);
      store.set('lastDest', target);
      close();
      toast(`Đã thêm ${n} mục vào hàng đợi. Lưu vào ${target}`, 'ok');
      expandQueue();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  browse.onclick = () => {
    const it = results.find((r) => r.ok).item;
    close();
    goDrive([{ id: it.id, name: it.name, driveId: it.driveId || null, resourceKey: it.resourceKey || null, icon: 'link' }]);
  };

  text.value = prefill;
  text.focus();
  if (prefill) resolveNow();
}

// ======================================================================= settings dialog

function openSettings() {
  const s = S.settings;
  const sel = (v, cur) => (String(v) === String(cur) ? 'selected' : '');
  const { modal, close } = openModal(`
    <div class="modal-head"><span class="pane-icon" data-icon="sliders"></span><div><h3>Cài đặt</h3><p>Lưu trên máy này. Token đăng nhập được mã hoá bởi hệ điều hành.</p></div></div>
    <div class="modal-body">
      <div class="section-title">Kết nối Google</div>
      <div class="help">
        DriveDock dùng OAuth Client của chính anh (miễn phí), nên không chia sẻ hạn mức với ai. Làm một lần:
        <ol>
          <li>Mở <a data-url="https://console.cloud.google.com/projectcreate">Google Cloud Console</a>, tạo một project.</li>
          <li>Bật <a data-url="https://console.cloud.google.com/apis/library/drive.googleapis.com">Google Drive API</a>.</li>
          <li>Vào <a data-url="https://console.cloud.google.com/auth/overview">Google Auth Platform</a>: chọn <i>External</i>, thêm email của anh vào <i>Test users</i> (hoặc bấm <i>Publish app</i> để token không hết hạn sau 7 ngày).</li>
          <li>Vào <a data-url="https://console.cloud.google.com/auth/clients">Clients</a> → <i>Create client</i> → loại <b>Desktop app</b> → tải file JSON.</li>
          <li>Bấm <b>Nhập từ credentials.json</b> bên dưới, rồi Lưu và bấm Kết nối Google Drive.</li>
        </ol>
      </div>
      <div class="grid2">
        <label class="field"><span>Client ID</span><input class="input" id="st-cid" spellcheck="false" placeholder="xxxx.apps.googleusercontent.com" /></label>
        <label class="field"><span>Client secret</span><input class="input" id="st-csec" type="password" spellcheck="false" placeholder="GOCSPX-…" /></label>
      </div>
      <div class="inline"><button class="btn" id="st-import"><span data-icon="upload"></span>Nhập từ credentials.json</button></div>
      <label class="field"><span>API key (tuỳ chọn)</span><input class="input" id="st-key" spellcheck="false" placeholder="AIza…" />
        <small>Cho phép tải cả thư mục công khai mà không cần đăng nhập.</small></label>

      <div class="section-title">Truyền file</div>
      <div class="grid2">
        <label class="field"><span>Số file chạy song song</span>
          <select class="select" id="st-conc">${[1, 2, 3, 4, 5, 6, 8].map((n) => `<option ${sel(n, s.concurrency)}>${n}</option>`).join('')}</select></label>
        <label class="field"><span>Số kết nối cho mỗi file lớn (≥ 16 MB)</span>
          <select class="select" id="st-conn">${[1, 2, 4, 6, 8].map((n) => `<option value="${n}" ${sel(n, s.connectionsPerFile)}>${n === 1 ? '1 (tắt tăng tốc)' : n}</option>`).join('')}</select></label>
        <label class="field"><span>Kích thước mỗi phần khi tải lên</span>
          <select class="select" id="st-chunk">${[8, 16, 32, 64, 128].map((n) => `<option value="${n}" ${sel(n, s.uploadChunkMB)}>${n} MB</option>`).join('')}</select></label>
        <label class="field"><span>Khi trùng tên</span>
          <select class="select" id="st-conflict">
            <option value="rename" ${sel('rename', s.conflict)}>Tự đổi tên: “ảnh (1).jpg”</option>
            <option value="skip" ${sel('skip', s.conflict)}>Bỏ qua file đã có</option>
            <option value="overwrite" ${sel('overwrite', s.conflict)}>Ghi đè (trên Drive: tạo phiên bản mới)</option>
          </select></label>
        <label class="field"><span>Google Docs / Sheets / Slides tải về dạng</span>
          <select class="select" id="st-export">
            <option value="office" ${sel('office', s.exportFormat)}>Microsoft Office (.docx .xlsx .pptx)</option>
            <option value="pdf" ${sel('pdf', s.exportFormat)}>PDF</option>
            <option value="open" ${sel('open', s.exportFormat)}>OpenDocument (.odt .ods .odp)</option>
          </select></label>
      </div>
      <label class="field"><span>Thư mục tải mặc định cho “Tải từ link”</span>
        <div class="inline"><input class="input" id="st-dir" spellcheck="false" placeholder="${esc(S.info.paths.downloads)}" /><button class="btn" id="st-pick">Chọn…</button></div></label>
      <label class="check"><input type="checkbox" id="st-md5" ${s.verifyMd5 ? 'checked' : ''} /> Kiểm tra MD5 sau khi tải xuống (phát hiện file hỏng)</label>
      <label class="check"><input type="checkbox" id="st-auto" ${s.autoResume ? 'checked' : ''} /> Tự tiếp tục hàng đợi khi mở app</label>
    </div>
    <div class="modal-foot"><small style="color:var(--muted)">DriveDock ${esc(S.info.version)}</small><div class="spacer"></div><button class="btn" data-close>Huỷ</button><button class="btn primary" id="st-save">Lưu</button></div>
  `);

  $('#st-cid', modal).value = s.clientId || '';
  $('#st-csec', modal).value = s.clientSecret || '';
  $('#st-key', modal).value = s.apiKey || '';
  $('#st-dir', modal).value = s.defaultDownloadDir || '';
  for (const a of $$('a[data-url]', modal)) a.onclick = () => api.openExternal(a.dataset.url);

  $('#st-import', modal).onclick = async () => {
    try {
      const out = await api.settings.importCredentials();
      if (!out) return;
      S.settings = out;
      $('#st-cid', modal).value = out.clientId;
      $('#st-csec', modal).value = out.clientSecret;
      toast('Đã nhập Client ID/Secret.', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  $('#st-pick', modal).onclick = async () => {
    const p = await api.pickFolder($('#st-dir', modal).value || S.info.paths.downloads);
    if (p) $('#st-dir', modal).value = p;
  };
  $('#st-save', modal).onclick = async () => {
    try {
      S.settings = await api.settings.set({
        clientId: $('#st-cid', modal).value.trim(),
        clientSecret: $('#st-csec', modal).value.trim(),
        apiKey: $('#st-key', modal).value.trim(),
        concurrency: Number($('#st-conc', modal).value),
        uploadChunkMB: Number($('#st-chunk', modal).value),
        connectionsPerFile: Number($('#st-conn', modal).value),
        conflict: $('#st-conflict', modal).value,
        exportFormat: $('#st-export', modal).value,
        defaultDownloadDir: $('#st-dir', modal).value.trim(),
        verifyMd5: $('#st-md5', modal).checked,
        autoResume: $('#st-auto', modal).checked,
      });
      $('#auto-resume').checked = S.settings.autoResume;
      S.auth = await api.auth.status();
      renderAccount();
      paneDrive.render();
      close();
      toast('Đã lưu cài đặt.', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

// ======================================================================= account

async function connect(btn) {
  if (!S.auth.configured) {
    toast('Cần nhập OAuth Client ID trước (chỉ làm một lần).');
    openSettings();
    return;
  }
  const old = btn ? btn.innerHTML : null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="width:14px;height:14px"></div>Đang chờ trình duyệt…';
  }
  try {
    S.auth = await api.auth.login();
    toast(`Đã kết nối ${S.auth.user?.emailAddress || 'Google Drive'}.`, 'ok');
    afterAuthChange();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }
}

function afterAuthChange() {
  renderAccount();
  S.quota = null;
  driveState.history = [];
  goDrive([DRIVE_PLACES.root], { push: false });
  if (S.auth.loggedIn) {
    api.drive.about().then((a) => {
      S.quota = a.storageQuota;
      paneDrive.renderFooter();
      renderStorage();
    }).catch(() => {});
  }
}

// Drive quota card: one segmented bar, color-coded like the file tiles.
function renderStorage() {
  const el = $('#storage');
  const q = S.quota;
  if (!S.auth.loggedIn || !q) {
    el.hidden = true;
    return;
  }
  const usage = Number(q.usage || 0);
  const drive = Number(q.usageInDrive || 0);
  const trash = Number(q.usageInDriveTrash || 0);
  const limit = q.limit ? Number(q.limit) : null;
  const other = Math.max(0, usage - drive);
  const total = limit || Math.max(usage, 1);
  const seg = (v, c) => (v > 0 ? `<i style="width:${Math.max(1, (v / total) * 100)}%;background:${c}"></i>` : '');
  el.hidden = false;
  el.innerHTML = `<div class="st-label">Dung lượng Drive</div>
    <div class="st-num">${fmtSize(usage)} <small>${limit ? `/ ${fmtSize(limit)}` : 'không giới hạn'}</small></div>
    <div class="st-bar">${seg(Math.max(0, drive - trash), 'var(--accent)')}${seg(trash, 'var(--hot)')}${seg(other, 'var(--warn)')}</div>
    <div class="st-legend"><span><b style="background:var(--accent)"></b>Drive</span><span><b style="background:var(--hot)"></b>Thùng rác</span><span><b style="background:var(--warn)"></b>Gmail, Ảnh</span></div>`;
}

function renderAccount() {
  const el = $('#account');
  el.classList.toggle('on', S.auth.loggedIn);
  renderStorage();
  if (S.auth.loggedIn) {
    const u = S.auth.user || {};
    const initial = esc((u.displayName || u.emailAddress || '?').trim()[0]?.toUpperCase() || '?');
    el.innerHTML = `<div class="avatar">${u.photoLink ? `<img src="${esc(u.photoLink)}" alt="" referrerpolicy="no-referrer" />` : initial}</div>
      <div class="who"><b>${esc(u.displayName || 'Google Drive')}</b><span>${esc(u.emailAddress || '')}</span></div>
      <button class="tool" id="btn-logout" title="Đăng xuất">${icon('logout', 15)}</button>`;
    const img = $('img', el);
    if (img) img.onerror = () => (img.parentElement.textContent = initial);
    $('#btn-logout', el).onclick = async () => {
      const ok = await confirmDialog({ title: 'Đăng xuất', message: 'Ngắt kết nối Google Drive khỏi DriveDock?', ok: 'Đăng xuất' });
      if (!ok) return;
      S.auth = await api.auth.logout();
      afterAuthChange();
    };
  } else {
    el.innerHTML = `<div class="avatar">${icon('cloud', 15)}</div><div class="who"><b>Chưa kết nối</b><span>Google Drive</span></div>
      <button class="btn small accent block" id="btn-login">Kết nối Google Drive</button>`;
    $('#btn-login', el).onclick = (e) => connect(e.currentTarget);
  }
}

// ======================================================================= sidebar

async function buildLocalNav() {
  const nav = $('#nav-local');
  const p = S.info.paths;
  const places = [
    { label: 'Desktop', path: p.desktop, icon: 'monitor' },
    { label: 'Tải xuống', path: p.downloads, icon: 'download' },
    { label: 'Tài liệu', path: p.documents, icon: 'fileText' },
    { label: 'Ảnh', path: p.pictures, icon: 'image' },
  ];
  const roots = await api.local.roots().catch(() => []);
  for (const r of roots.slice(0, 6)) places.push({ label: Paths.win ? `Ổ ${r.name}` : r.name, path: r.path, icon: 'hdd' });
  nav.innerHTML = '';
  const seen = new Set();
  for (const pl of places) {
    if (!pl.path || seen.has(pl.path)) continue;
    seen.add(pl.path);
    const b = document.createElement('button');
    b.className = 'nav-item';
    b.dataset.path = pl.path;
    b.innerHTML = `${icon(pl.icon, 16)}<span>${esc(pl.label)}</span>`;
    b.title = pl.path;
    b.onclick = () => {
      goLocal(pl.path);
      paneLocal.el.focus();
    };
    nav.appendChild(b);
  }
  highlightNav();
}

function highlightNav() {
  const root = driveState.stack[0];
  for (const b of $$('#nav-drive .nav-item')) b.classList.toggle('on', driveState.stack.length >= 1 && root.id === b.dataset.place);
  for (const b of $$('#nav-local .nav-item')) b.classList.toggle('on', b.dataset.path === localState.path);
}

function bindSidebar() {
  for (const b of $$('#nav-drive .nav-item')) {
    b.onclick = () => {
      goDrive([DRIVE_PLACES[b.dataset.place]]);
      paneDrive.el.focus();
    };
  }
  $('#btn-settings').onclick = () => openSettings();
  $('#btn-theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
  setTheme(document.documentElement.dataset.theme, false);

  const input = $('#linkbar-input');
  $('#linkbar').onsubmit = (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = '';
    input.blur();
    openLinkModal(text);
  };
  input.addEventListener('paste', () => {
    // Pasting a link is the whole gesture: go straight to the preview.
    setTimeout(() => {
      if (LINK_HINT.test(input.value)) $('#linkbar').requestSubmit();
    }, 0);
  });

  $('#spine-up').onclick = () => paneLocal.transferSelection();
  $('#spine-down').onclick = () => paneDrive.transferSelection();
}

function setTheme(theme, save) {
  document.documentElement.dataset.theme = theme;
  if (save) store.set('theme', theme);
  $('#btn-theme').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 16);
  $('#btn-theme').title = theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối';
  api.setTheme && api.setTheme(theme).catch(() => {});
}

// Spine arrows are live only when there is something to send and somewhere to send it.
function updateSpine() {
  if (!paneLocal || !paneDrive) return;
  const upOk = S.auth.loggedIn && isRealFolder(driveCur()) && paneLocal.sel.size > 0 && Boolean(localState.path);
  const downOk = S.auth.loggedIn && Boolean(localState.path) && paneDrive.sel.size > 0;
  $('#spine-up').disabled = !upOk;
  $('#spine-down').disabled = !downOk;
  const nUp = paneLocal.sel.size;
  const nDown = paneDrive.sel.size;
  $('#spine-up').title = nUp ? `Tải ${nUp} mục đã chọn lên Google Drive` : 'Chọn file bên trái để tải lên Drive';
  $('#spine-down').title = nDown ? `Tải ${nDown} mục đã chọn về máy` : 'Chọn file bên phải để tải về máy';
}

// ======================================================================= context menus

function localMenu(e, items) {
  const one = items.length === 1 ? items[0] : null;
  const menu = [];
  if (items.length) {
    if (one) menu.push({ label: one.isDir ? 'Mở' : 'Mở bằng ứng dụng mặc định', icon: 'open', kbd: 'Enter', run: () => localAdapter.open(one) });
    menu.push({ label: 'Tải lên Google Drive', icon: 'upload', disabled: !S.auth.loggedIn || !isRealFolder(driveCur()), run: () => paneLocal.onTransfer(items) });
    if (one && !one.isRoot) menu.push({ label: 'Hiện trong thư mục', icon: 'eye', run: () => api.local.reveal(one.path) });
    menu.push('-');
    if (one && !one.isRoot) menu.push({ label: 'Đổi tên', icon: 'edit', kbd: 'F2', run: () => localAdapter.rename(one) });
    menu.push({ label: 'Xoá vào Thùng rác', icon: 'trash', kbd: 'Del', danger: true, disabled: items.some((i) => i.isRoot), run: () => localAdapter.remove(items) });
    menu.push('-');
  }
  menu.push({ label: 'Thư mục mới', icon: 'folderPlus', disabled: !localState.path, run: () => localAdapter.mkdir() });
  menu.push({ label: 'Làm mới', icon: 'refresh', kbd: 'F5', run: () => paneLocal.reload() });
  showMenu(e.clientX, e.clientY, menu);
}

function driveMenu(e, items) {
  if (!S.auth.loggedIn) return;
  const one = items.length === 1 ? items[0] : null;
  const menu = [];
  if (items.length) {
    if (one && isDriveDir(one)) menu.push({ label: 'Mở', icon: 'open', kbd: 'Enter', run: () => driveAdapter.open(one) });
    else if (one && one.webViewLink) menu.push({ label: 'Mở trên trình duyệt', icon: 'open', run: () => api.openExternal(one.webViewLink) });
    menu.push({ label: 'Tải xuống máy', icon: 'download', disabled: !localState.path, run: () => paneDrive.onTransfer(items) });
    if (one && one.webViewLink) {
      menu.push({
        label: 'Sao chép link',
        icon: 'copy',
        run: () => navigator.clipboard.writeText(one.webViewLink).then(() => toast('Đã sao chép link.', 'ok')),
      });
    }
    menu.push('-');
    if (one && !one.isSharedDrive) menu.push({ label: 'Đổi tên', icon: 'edit', kbd: 'F2', disabled: one.capabilities && !one.capabilities.canRename, run: () => driveAdapter.rename(one) });
    menu.push({ label: 'Chuyển vào thùng rác', icon: 'trash', kbd: 'Del', danger: true, disabled: items.some((i) => i.isSharedDrive), run: () => driveAdapter.remove(items) });
    menu.push('-');
  }
  menu.push({ label: 'Thư mục mới', icon: 'folderPlus', disabled: !isRealFolder(driveCur()), run: () => driveAdapter.mkdir() });
  menu.push({ label: 'Làm mới', icon: 'refresh', kbd: 'F5', run: () => paneDrive.reload() });
  showMenu(e.clientX, e.clientY, menu);
}

// ======================================================================= layout splitters

function bindSplitters() {
  const panes = $('#panes');
  const main = $('#main');
  const setRatio = (r) => {
    r = Math.min(0.8, Math.max(0.2, r));
    panes.style.setProperty('--left', `${r}fr`);
    panes.style.setProperty('--right', `${1 - r}fr`);
    return r;
  };
  const setQueueH = (h) => {
    h = Math.min(innerHeight - 260, Math.max(120, h));
    main.style.setProperty('--queue-h', `${h}px`);
    return h;
  };
  setRatio(store.get('paneRatio', 0.5));
  setQueueH(store.get('queueH', 260));
  setQueueCollapsed(store.get('queueCollapsed', false));

  const drag = (el, onMove, onEnd) => {
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const move = (ev) => onMove(ev);
      const up = (ev) => {
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        onEnd(ev);
      };
      document.body.style.cursor = getComputedStyle(el).cursor;
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
  };
  let ratio = store.get('paneRatio', 0.5);
  drag($('#spine'), (e) => {
    const r = panes.getBoundingClientRect();
    ratio = setRatio((e.clientX - r.left) / r.width);
  }, () => store.set('paneRatio', ratio));
  let qh = store.get('queueH', 260);
  drag($('#hsplit'), (e) => {
    if (main.classList.contains('queue-collapsed')) setQueueCollapsed(false);
    qh = setQueueH(innerHeight - e.clientY - 4);
  }, () => store.set('queueH', qh));
}

// ======================================================================= global keys

const LINK_HINT = /(drive|docs)\.google\.com|drive\.usercontent\.google\.com/i;

function bindGlobalKeys() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' && !$('#modal-root').children.length) {
      e.preventDefault();
      $('#linkbar-input').focus();
    }
  });
  document.addEventListener('paste', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if ($('#modal-root').children.length) return;
    const text = e.clipboardData.getData('text');
    if (LINK_HINT.test(text)) {
      e.preventDefault();
      openLinkModal(text);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#menu')) hideMenu();
  });
  addEventListener('blur', hideMenu);
  addEventListener('resize', hideMenu);
}

// ======================================================================= boot

let paneLocal;
let paneDrive;

async function boot() {
  hydrateIcons();
  S.info = await api.info();
  Paths.init(S.info.platform);
  [S.settings, S.auth] = await Promise.all([api.settings.get(), api.auth.status()]);

  paneLocal = new Pane($('#pane-local'), localAdapter);
  paneDrive = new Pane($('#pane-drive'), driveAdapter);
  const focus = (p) => {
    paneLocal.el.classList.toggle('focused', p === paneLocal);
    paneDrive.el.classList.toggle('focused', p === paneDrive);
  };
  paneLocal.onFocus = focus;
  paneDrive.onFocus = focus;

  paneLocal.onTransfer = (items) => uploadPaths(items.map((i) => i.path), driveCur(), driveState.stack);
  paneDrive.onTransfer = (items) => downloadItems(items, localState.path);
  paneLocal.onDropItems = (_from, items, target) => downloadItems(items, target ? target.path : localState.path);
  paneDrive.onDropItems = (_from, items, target) => {
    const { loc, stack } = driveDropTarget(target);
    uploadPaths(items.map((i) => i.path), loc, stack);
  };
  paneDrive.onDropFiles = (paths, target) => {
    const { loc, stack } = driveDropTarget(target);
    uploadPaths(paths, loc, stack);
  };
  paneLocal.onSelect = updateSpine;
  paneDrive.onSelect = updateSpine;
  paneLocal.onContext = localMenu;
  paneDrive.onContext = driveMenu;

  bindSidebar();
  bindSplitters();
  bindQueue();
  bindGlobalKeys();
  renderAccount();

  api.auth.onChange((s) => {
    const was = S.auth.loggedIn;
    S.auth = s;
    renderAccount();
    if (was !== s.loggedIn) afterAuthChange();
  });

  let start = store.get('localPath', null);
  if (start && !(await api.local.exists(start).catch(() => false))) start = null;
  localState.path = start || S.info.paths.downloads;
  paneLocal.navigated();
  afterAuthChange();
  buildLocalNav();

  const snap = await api.queue.snapshot();
  qApply({ changed: snap.tasks, removed: [], order: snap.tasks.map((t) => t.id), stats: snap.stats });
  paneLocal.el.focus();
}

boot().catch((e) => {
  console.error(e);
  toast(`Lỗi khởi động: ${e.message}`, 'error', 15000);
});
