'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Task status lifecycle:
//   queued -> running -> done | skipped | error
//   queued/running -> paused -> queued
//   any unfinished -> canceled
const FINISHED = new Set(['done', 'skipped', 'canceled']);
const ACTIVE = new Set(['queued', 'running']);

const SPEED_WINDOW_MS = 4000;
const EMIT_INTERVAL_MS = 250;

class TransferQueue extends EventEmitter {
  // runners: { [task.type]: async (task, ctx) => ({ status?: 'done'|'skipped', note? }) }
  // hooks.onCancel(task): cleanup after a task is canceled (e.g. delete a partial file).
  constructor({ file, runners, hooks = {}, getConcurrency = () => 3, getMaxRetries = () => 6, getAutoResume = () => false, gate = () => true }) {
    super();
    this.gate = gate; // () => bool: false outside the allowed time window
    this.file = file;
    this.runners = runners;
    this.hooks = hooks;
    this.getConcurrency = getConcurrency;
    this.getMaxRetries = getMaxRetries;
    this.tasks = new Map();
    this.order = [];
    this.live = new Map(); // id -> { controller, samples }
    this.dirty = new Set();
    this.removed = new Set();
    this.emitTimer = null;
    this.saveTimer = null;
    this.wakeTimer = null;
    if (file) this._load(getAutoResume());
  }

  _load(autoResume) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    for (const t of data.tasks || []) {
      if (ACTIVE.has(t.status)) t.status = autoResume ? 'queued' : 'paused';
      t.speed = 0;
      t.eta = null;
      t.notBefore = 0;
      this.tasks.set(t.id, t);
      this.order.push(t.id);
    }
  }

  _persist() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const tasks = this.order.map((id) => this.tasks.get(id));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks }));
    fs.renameSync(tmp, this.file);
  }

  // Tells the UI when the time window opens or closes (stats.gated changes).
  _announceGate(closed) {
    if (this._gateClosed === closed) return;
    this._gateClosed = closed;
    this.forceEmit = true;
    this._emitSoon();
  }

  _touch(task) {
    this.dirty.add(task.id);
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => this._emitNow(), EMIT_INTERVAL_MS);
    }
  }

  _emitNow() {
    clearTimeout(this.emitTimer);
    this.emitTimer = null;
    const changed = [...this.dirty].map((id) => this.tasks.get(id)).filter(Boolean).map(publicView);
    const removed = [...this.removed];
    this.dirty.clear();
    this.removed.clear();
    const force = this.forceEmit;
    this.forceEmit = false;
    if (changed.length || removed.length || force) this.emit('update', { changed, removed, order: this.order.slice(), stats: this.stats() });
    this._persist();
  }

  _set(task, patch) {
    Object.assign(task, patch);
    this._touch(task);
  }

  snapshot() {
    return { tasks: this.order.map((id) => publicView(this.tasks.get(id))), stats: this.stats() };
  }

  stats() {
    let running = 0;
    let queued = 0;
    let speed = 0;
    let errors = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') {
        running++;
        speed += t.speed || 0;
      } else if (t.status === 'queued') queued++;
      else if (t.status === 'error') errors++;
    }
    return { running, queued, errors, speed, total: this.tasks.size, gated: !this.gate() };
  }

  // specs: partial tasks { type, name, source, dest, ... }. `after`: insert after this task id (used for folder children).
  add(specs, { after, paused = false } = {}) {
    const created = [];
    for (const spec of specs) {
      const task = {
        id: crypto.randomUUID(),
        status: paused ? 'paused' : 'queued',
        transferred: 0,
        size: null,
        speed: 0,
        eta: null,
        attempts: 0,
        error: null,
        note: null,
        createdAt: Date.now(),
        notBefore: 0,
        ...spec,
      };
      this.tasks.set(task.id, task);
      created.push(task);
      this._touch(task);
    }
    const ids = created.map((t) => t.id);
    const idx = after ? this.order.indexOf(after) : -1;
    if (idx === -1) this.order.push(...ids);
    else {
      // Keep children of `after` together: insert after its last already-inserted descendant.
      let insertAt = idx + 1;
      while (insertAt < this.order.length && this.tasks.get(this.order[insertAt])?.parentTask === after) insertAt++;
      this.order.splice(insertAt, 0, ...ids);
    }
    this._schedule();
    return created.map(publicView);
  }

  _schedule() {
    clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (this.stopped) return;
    if (!this.gate()) {
      // Outside the allowed window: stop what is running (progress is kept) and start nothing new.
      for (const [id, live] of this.live) {
        const t = this.tasks.get(id);
        if (t && t.status === 'running') this._set(t, { status: 'queued', speed: 0, eta: null });
        live.controller.abort(new Error('window closed'));
      }
      this._announceGate(true);
      return;
    }
    this._announceGate(false);
    const limit = this.getConcurrency();
    let running = 0;
    for (const t of this.tasks.values()) if (t.status === 'running') running++;
    const now = Date.now();
    let nextWake = Infinity;
    for (const id of this.order) {
      if (running >= limit) break;
      const t = this.tasks.get(id);
      if (t.status !== 'queued') continue;
      if (t.notBefore > now) {
        nextWake = Math.min(nextWake, t.notBefore);
        continue;
      }
      running++;
      this._run(t);
    }
    if (nextWake !== Infinity) {
      this.wakeTimer = setTimeout(() => this._schedule(), Math.max(50, nextWake - now));
    }
  }

  async _run(task) {
    const runner = this.runners[task.type];
    const controller = new AbortController();
    const live = { controller, samples: [], startBytes: task.transferred || 0 };
    this.live.set(task.id, live);
    this._set(task, { status: 'running', error: null, startedAt: task.startedAt || Date.now() });

    const ctx = {
      signal: controller.signal,
      progress: (transferred, size) => {
        const now = Date.now();
        live.samples.push([now, transferred]);
        while (live.samples.length > 2 && now - live.samples[0][0] > SPEED_WINDOW_MS) live.samples.shift();
        const [t0, b0] = live.samples[0];
        const speed = now - t0 > 300 ? ((transferred - b0) * 1000) / (now - t0) : task.speed;
        const total = size ?? task.size;
        const eta = speed > 0 && total ? Math.max(0, (total - transferred) / speed) : null;
        // Real progress since the last failure: give the task a fresh retry budget.
        const attempts = task.attempts && transferred - live.startBytes > 1024 * 1024 ? 0 : task.attempts;
        this._set(task, { transferred, speed, eta, attempts, ...(size !== undefined ? { size } : {}) });
      },
      update: (patch) => this._set(task, patch),
      enqueue: (specs) => this.add(specs.map((s) => ({ parentTask: task.id, ...s })), { after: task.id }),
    };

    try {
      if (!runner) throw new Error(`Không có runner cho loại "${task.type}"`);
      const result = (await runner(task, ctx)) || {};
      this._set(task, { status: result.status || 'done', note: result.note ?? task.note, speed: 0, eta: null, finishedAt: Date.now() });
    } catch (err) {
      if (controller.signal.aborted) {
        // pause() / cancel() already set the final status.
        this._set(task, { speed: 0, eta: null });
      } else if (err && err.retryable && task.attempts < this.getMaxRetries()) {
        const attempts = task.attempts + 1;
        const delay = Math.min(60_000, 2000 * 2 ** (attempts - 1));
        this._set(task, { status: 'queued', attempts, notBefore: Date.now() + delay, speed: 0, eta: null, note: `Thử lại lần ${attempts}: ${err.message}` });
      } else {
        this._set(task, { status: 'error', error: (err && err.message) || String(err), speed: 0, eta: null });
      }
    } finally {
      this.live.delete(task.id);
      if (task.status === 'canceled' && this.hooks.onCancel) {
        Promise.resolve(this.hooks.onCancel(task)).catch(() => {});
      }
      this._schedule();
    }
  }

  _ids(ids) {
    return (ids === 'all' ? this.order.slice() : ids).map((id) => this.tasks.get(id)).filter(Boolean);
  }

  pause(ids) {
    for (const t of this._ids(ids)) {
      if (!ACTIVE.has(t.status)) continue;
      this._set(t, { status: 'paused', speed: 0, eta: null });
      this.live.get(t.id)?.controller.abort(new Error('paused'));
    }
    this._schedule();
  }

  resume(ids) {
    for (const t of this._ids(ids)) {
      if (t.status === 'paused' || t.status === 'error') this._set(t, { status: 'queued', notBefore: 0, error: null });
    }
    this._schedule();
  }

  retry(ids) {
    for (const t of this._ids(ids)) {
      if (t.status === 'error' || t.status === 'canceled' || t.status === 'skipped') {
        this._set(t, { status: 'queued', attempts: 0, notBefore: 0, error: null, note: null });
      }
    }
    this._schedule();
  }

  cancel(ids) {
    for (const t of this._ids(ids)) {
      if (FINISHED.has(t.status)) continue;
      const wasRunning = this.live.has(t.id);
      this._set(t, { status: 'canceled', speed: 0, eta: null });
      if (wasRunning) this.live.get(t.id).controller.abort(new Error('canceled'));
      else if (this.hooks.onCancel) Promise.resolve(this.hooks.onCancel(t)).catch(() => {});
    }
    this._schedule();
  }

  remove(ids) {
    for (const t of this._ids(ids)) {
      if (t.status === 'running') continue;
      if (!FINISHED.has(t.status) && this.hooks.onCancel) Promise.resolve(this.hooks.onCancel(t)).catch(() => {});
      this.tasks.delete(t.id);
      this.removed.add(t.id);
    }
    this.order = this.order.filter((id) => this.tasks.has(id));
    this.removed.size && this._emitSoon();
  }

  clearFinished() {
    this.remove(this.order.filter((id) => FINISHED.has(this.tasks.get(id).status)));
  }

  _emitSoon() {
    if (!this.emitTimer) this.emitTimer = setTimeout(() => this._emitNow(), EMIT_INTERVAL_MS);
  }

  hasActive() {
    for (const t of this.tasks.values()) if (t.status === 'running') return true;
    return false;
  }

  // Stops running tasks so they resume next launch (called on app quit).
  shutdown() {
    this.stopped = true;
    for (const [id, live] of this.live) {
      const t = this.tasks.get(id);
      if (t && t.status === 'running') t.status = 'queued';
      live.controller.abort(new Error('shutdown'));
    }
    this.flush();
  }
}

// Fields sent to the renderer (drops internal bookkeeping such as upload session URIs).
function publicView(t) {
  return {
    id: t.id,
    type: t.type,
    kind: t.kind,
    status: t.status,
    name: t.name,
    source: t.source,
    dest: t.dest,
    size: t.size,
    transferred: t.transferred,
    speed: t.speed,
    eta: t.eta,
    error: t.error,
    note: t.note,
    isFolder: Boolean(t.isFolder),
    localPath: t.localPath || t.finalPath || null,
    parentTask: t.parentTask || null,
  };
}

module.exports = { TransferQueue, FINISHED };
