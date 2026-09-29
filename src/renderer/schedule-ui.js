'use strict';

// Scheduled jobs UI: list, editor, and the sidebar badge. Uses globals from util.js / app.js at call time.

const DAY_NAMES = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
const DAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

const Sched = { jobs: [], render: null };

function describeRepeat(r) {
  if (!r) return '';
  switch (r.kind) {
    case 'once': return `Một lần lúc ${fmtDate(r.at)}`;
    case 'interval': return r.minutes % 60 === 0 ? `Mỗi ${r.minutes / 60} giờ` : `Mỗi ${r.minutes} phút`;
    case 'daily': return `Hằng ngày lúc ${r.time}`;
    case 'weekly': return `${(r.days || []).slice().sort().map((d) => DAY_SHORT[d]).join(', ')} lúc ${r.time}`;
    default: return '';
  }
}

function describeJob(j) {
  const p = j.params || {};
  if (j.type === 'download') {
    const n = String(p.links || '').split(/\s+/).filter(Boolean).length;
    return `Tải ${n} link về ${p.destDir}`;
  }
  const dir = { both: '⇄', up: '→', down: '←' }[p.direction || 'both'];
  return `${p.localDir} ${dir} ${p.label || 'Drive'}`;
}

function updateScheduleBadge() {
  const n = Sched.jobs.filter((j) => j.enabled).length;
  const b = $('#sched-badge');
  if (!b) return;
  b.hidden = !n;
  b.textContent = n;
}

async function initSchedule() {
  Sched.jobs = await api.schedule.list();
  updateScheduleBadge();
  api.schedule.onChange((jobs) => {
    Sched.jobs = jobs;
    updateScheduleBadge();
    Sched.render && Sched.render();
  });
  $('#nav-schedule').onclick = () => openScheduleModal();
}

function openScheduleModal() {
  const { modal, close } = openModal(`
    <div class="modal-head"><span class="pane-icon drive" data-icon="clock"></span>
      <div><h3>Lịch tự động</h3><p>Tải link hoặc đồng bộ thư mục theo giờ. Lịch chỉ chạy khi DriveDock đang mở; nếu lỡ giờ vì đã tắt app, lịch sẽ chạy bù ngay khi anh mở lại.</p></div></div>
    <div class="modal-body"><div class="bg-note" id="bg-note" hidden></div><div class="sched-list" id="sched-list"></div></div>
    <div class="modal-foot"><div class="spacer"></div><button class="btn" data-close>Đóng</button><button class="btn primary" id="sched-add"><span data-icon="plus"></span>Thêm lịch</button></div>`,
  { onClose: () => { Sched.render = null; } });
  const list = $('#sched-list', modal);
  const note = $('#bg-note', modal);
  if (!S.settings.closeToTray) {
    note.hidden = false;
    note.innerHTML = `${icon('alert', 15)}<span>Lịch chỉ chạy khi DriveDock đang mở. Bật chạy nền để đóng cửa sổ mà lịch vẫn hoạt động.</span><button class="btn small" id="bg-on">Bật chạy nền</button>`;
    $('#bg-on', modal).onclick = async () => {
      try {
        S.settings = await api.settings.set({ closeToTray: true, startWithSystem: true });
        note.hidden = true;
        toast('Đã bật chạy nền: đóng cửa sổ sẽ thu vào khay, và DriveDock tự mở khi đăng nhập máy.', 'ok', 6000);
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  }

  Sched.render = () => {
    if (!Sched.jobs.length) {
      list.innerHTML = '<div class="help">Chưa có lịch nào. Ví dụ: <b>sao lưu thư mục Ảnh lên Drive lúc 23:00 mỗi đêm</b>, hoặc <b>tải một thư mục được chia sẻ vào 2 giờ sáng</b> khi mạng rảnh.</div>';
      return;
    }
    list.innerHTML = Sched.jobs.map((j) => {
      const last = j.lastResult ? `<span class="pill ${j.lastResult.ok ? 'done' : 'error'}">${j.lastResult.ok ? 'Lần trước OK' : 'Lần trước lỗi'}</span> <span class="jr-msg" title="${esc(j.lastResult.message)}">${fmtDate(j.lastRun)} · ${esc(j.lastResult.message)}</span>` : '<span class="jr-msg">Chưa chạy lần nào</span>';
      return `<div class="job-row" data-id="${j.id}">
        <label class="switch"><input type="checkbox" data-a="toggle" ${j.enabled ? 'checked' : ''} /><span class="track"></span></label>
        <div class="jr-main">
          <div class="jr-name">${icon(j.type === 'sync' ? 'refresh' : 'download', 14)}<b>${esc(j.name)}</b>${j.running ? '<span class="pill running">Đang chạy</span>' : ''}</div>
          <div class="jr-desc" title="${esc(describeJob(j))}">${esc(describeJob(j))}</div>
          <div class="jr-when">${esc(describeRepeat(j.repeat))} · ${j.enabled && j.nextRun ? `chạy tiếp lúc <b>${fmtDate(j.nextRun)}</b>` : 'đang tắt'}</div>
          <div class="jr-last">${last}</div>
        </div>
        <div class="jr-acts">
          <button class="icon-btn" data-a="run" title="Chạy ngay">${icon('play', 15)}</button>
          <button class="icon-btn" data-a="edit" title="Sửa">${icon('edit', 15)}</button>
          <button class="icon-btn" data-a="del" title="Xoá lịch">${icon('trash', 15)}</button>
        </div></div>`;
    }).join('');
  };
  Sched.render();

  list.onclick = async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const id = b.closest('.job-row').dataset.id;
    const job = Sched.jobs.find((j) => j.id === id);
    try {
      if (b.dataset.a === 'toggle') await api.schedule.setEnabled(id, b.checked);
      else if (b.dataset.a === 'run') {
        toast('Đang chạy lịch…');
        const r = await api.schedule.runNow(id);
        toast(r.message, r.ok ? 'ok' : 'error');
        if (r.ok) expandQueue();
      } else if (b.dataset.a === 'edit') { close(); openJobEditor(job); }
      else if (b.dataset.a === 'del') {
        if (await confirmDialog({ title: 'Xoá lịch', message: `Xoá lịch "${job.name}"? Các file đã tải không bị ảnh hưởng.`, ok: 'Xoá', danger: true })) await api.schedule.remove(id);
      }
    } catch (err) {
      toast(err.message, 'error');
      if (b.dataset.a === 'toggle') Sched.render();
    }
  };
  $('#sched-add', modal).onclick = () => { close(); openJobEditor(null); };
}

const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function openJobEditor(job) {
  const p = (job && job.params) || {};
  const r = (job && job.repeat) || { kind: 'daily', time: '23:00' };
  let driveFolder = p.folder ? { folder: p.folder, label: p.label } : null;
  if (!driveFolder && S.auth.loggedIn && isRealFolder(driveCur())) {
    const c = driveCur();
    driveFolder = { folder: { id: c.id, driveId: c.driveId || null, resourceKey: c.resourceKey || null }, label: driveLabel(driveState.stack) };
  }
  const sel = (a, b) => (a === b ? 'selected' : '');

  const { modal, close } = openModal(`
    <div class="modal-head"><span class="pane-icon drive" data-icon="clock"></span><div><h3>${job ? 'Sửa lịch' : 'Lịch mới'}</h3></div></div>
    <div class="modal-body">
      <div class="grid2">
        <label class="field"><span>Tên lịch</span><input class="input" id="j-name" spellcheck="false" placeholder="Ví dụ: Sao lưu ảnh mỗi đêm" /></label>
        <label class="field"><span>Việc cần làm</span>
          <select class="select" id="j-type">
            <option value="sync" ${sel('sync', job?.type)}>Đồng bộ thư mục</option>
            <option value="download" ${sel('download', job?.type)}>Tải từ link Google Drive</option>
          </select></label>
      </div>

      <div id="j-sync" class="modal-body" style="padding:0">
        <label class="field"><span>Thư mục trên máy</span><div class="inline"><input class="input" id="j-local" spellcheck="false" /><button class="btn" id="j-local-pick">Chọn…</button></div></label>
        <label class="field"><span>Thư mục trên Drive</span><div class="inline"><input class="input" id="j-drive" readonly placeholder="Mở một thư mục ở khung Drive rồi bấm nút bên cạnh" /><button class="btn" id="j-drive-use">Dùng thư mục Drive đang mở</button></div></label>
        <div class="grid2">
          <label class="field"><span>Hướng</span>
            <select class="select" id="j-dir">
              <option value="up" ${sel('up', p.direction)}>Chỉ tải lên Drive (sao lưu)</option>
              <option value="down" ${sel('down', p.direction)}>Chỉ tải về máy</option>
              <option value="both" ${sel('both', p.direction || 'both')}>Hai chiều (copy phần thiếu mỗi bên)</option>
            </select></label>
          <label class="field"><span>File khác nhau</span>
            <select class="select" id="j-over"><option value="0">Giữ nguyên, không thay</option><option value="1" ${p.overwrite ? 'selected' : ''}>Thay bản cũ bằng bản mới hơn</option></select></label>
        </div>
        <small style="color:var(--muted)">Lịch đồng bộ không bao giờ xoá file, ở cả hai phía.</small>
      </div>

      <div id="j-dl" class="modal-body" style="padding:0">
        <label class="field"><span>Link Google Drive (mỗi link một dòng)</span><textarea class="input" id="j-links" spellcheck="false" placeholder="https://drive.google.com/drive/folders/…"></textarea></label>
        <label class="field"><span>Lưu vào</span><div class="inline"><input class="input" id="j-dest" spellcheck="false" /><button class="btn" id="j-dest-pick">Chọn…</button></div></label>
      </div>

      <div class="section-title">Khi nào</div>
      <div class="grid2">
        <label class="field"><span>Lặp lại</span>
          <select class="select" id="j-kind">
            <option value="daily" ${sel('daily', r.kind)}>Hằng ngày</option>
            <option value="weekly" ${sel('weekly', r.kind)}>Vài ngày trong tuần</option>
            <option value="interval" ${sel('interval', r.kind)}>Cách một khoảng thời gian</option>
            <option value="once" ${sel('once', r.kind)}>Một lần</option>
          </select></label>
        <label class="field" id="j-time-f"><span>Lúc</span><input class="input" id="j-time" type="time" /></label>
        <label class="field" id="j-at-f"><span>Vào ngày giờ</span><input class="input" id="j-at" type="datetime-local" /></label>
        <label class="field" id="j-min-f"><span>Mỗi</span>
          <select class="select" id="j-min">${[[15, '15 phút'], [30, '30 phút'], [60, '1 giờ'], [180, '3 giờ'], [360, '6 giờ'], [720, '12 giờ']].map(([m, t]) => `<option value="${m}" ${sel(m, r.minutes)}>${t}</option>`).join('')}</select></label>
      </div>
      <div class="days" id="j-days">${DAY_NAMES.map((n, i) => `<label class="chk-chip"><input type="checkbox" value="${i}" ${(r.days || [1, 2, 3, 4, 5]).includes(i) ? 'checked' : ''} /><span>${DAY_SHORT[i]}</span></label>`).join('')}</div>
    </div>
    <div class="modal-foot"><small id="j-err" style="color:var(--danger)"></small><div class="spacer"></div><button class="btn" data-close>Huỷ</button><button class="btn primary" id="j-save">Lưu lịch</button></div>`,
  { onClose: () => openScheduleModal() });

  const $$$ = (id) => $(`#${id}`, modal);
  $$$('j-name').value = job ? job.name : '';
  $$$('j-local').value = p.localDir || localState.path || '';
  $$$('j-drive').value = driveFolder ? driveFolder.label : '';
  $$$('j-links').value = p.links || '';
  $$$('j-dest').value = p.destDir || S.settings.defaultDownloadDir || S.info.paths.downloads;
  $$$('j-time').value = r.time || '23:00';
  $$$('j-at').value = toLocalInput(r.kind === 'once' ? r.at : Date.now() + 3600_000);

  const layout = () => {
    const type = $$$('j-type').value;
    const kind = $$$('j-kind').value;
    $$$('j-sync').hidden = type !== 'sync';
    $$$('j-dl').hidden = type !== 'download';
    $$$('j-time-f').hidden = !(kind === 'daily' || kind === 'weekly');
    $$$('j-days').hidden = kind !== 'weekly';
    $$$('j-at-f').hidden = kind !== 'once';
    $$$('j-min-f').hidden = kind !== 'interval';
  };
  $$$('j-type').onchange = layout;
  $$$('j-kind').onchange = layout;
  layout();

  const pick = (input) => async () => { const d = await api.pickFolder(input.value || undefined); if (d) input.value = d; };
  $$$('j-local-pick').onclick = pick($$$('j-local'));
  $$$('j-dest-pick').onclick = pick($$$('j-dest'));
  $$$('j-drive-use').onclick = () => {
    const c = driveCur();
    if (!S.auth.loggedIn || !isRealFolder(c)) return toast('Hãy mở một thư mục thật trong khung Drive trước (không phải "Được chia sẻ").', 'error');
    driveFolder = { folder: { id: c.id, driveId: c.driveId || null, resourceKey: c.resourceKey || null }, label: driveLabel(driveState.stack) };
    $$$('j-drive').value = driveFolder.label;
  };

  $$$('j-save').onclick = async () => {
    const err = $$$('j-err');
    err.textContent = '';
    const type = $$$('j-type').value;
    const kind = $$('#j-days input', modal);
    let repeat;
    switch ($$$('j-kind').value) {
      case 'daily': repeat = { kind: 'daily', time: $$$('j-time').value }; break;
      case 'weekly': repeat = { kind: 'weekly', time: $$$('j-time').value, days: kind.filter((c) => c.checked).map((c) => Number(c.value)) }; break;
      case 'interval': repeat = { kind: 'interval', minutes: Number($$$('j-min').value) }; break;
      default: repeat = { kind: 'once', at: Date.parse($$$('j-at').value) };
    }
    let params;
    if (type === 'sync') {
      if (!$$$('j-local').value.trim()) return (err.textContent = 'Chọn thư mục trên máy.');
      if (!driveFolder) return (err.textContent = 'Chọn thư mục trên Drive.');
      params = { localDir: $$$('j-local').value.trim(), folder: driveFolder.folder, label: driveFolder.label, direction: $$$('j-dir').value, overwrite: $$$('j-over').value === '1' };
    } else {
      if (!$$$('j-links').value.trim()) return (err.textContent = 'Dán ít nhất một link.');
      if (!$$$('j-dest').value.trim()) return (err.textContent = 'Chọn thư mục lưu.');
      params = { links: $$$('j-links').value.trim(), destDir: $$$('j-dest').value.trim() };
    }
    try {
      await api.schedule.save({ id: job?.id, name: $$$('j-name').value, enabled: job ? job.enabled : true, type, params, repeat });
      close();
      toast('Đã lưu lịch.', 'ok');
    } catch (e) {
      err.textContent = e.message;
    }
  };
}
