'use strict';

// Time rules and the job scheduler. All times are local wall-clock time.
//
// repeat: { kind: 'once', at }               at = epoch ms
//         { kind: 'interval', minutes }      every N minutes after the previous start
//         { kind: 'daily', time: 'HH:MM' }
//         { kind: 'weekly', time: 'HH:MM', days: [0..6] }   0 = Sunday

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseTime(t) {
  const m = TIME_RE.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function atMinutes(base, dayOffset, minutes) {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
}

// First run time strictly after `from` (epoch ms), or null when the job will not run again.
function nextRun(repeat, from) {
  if (!repeat) return null;
  const now = new Date(from);
  switch (repeat.kind) {
    case 'once':
      return repeat.at > from ? repeat.at : null;
    case 'interval': {
      const m = Math.max(1, Math.round(Number(repeat.minutes) || 0));
      return from + m * 60_000;
    }
    case 'daily':
    case 'weekly': {
      const mins = parseTime(repeat.time);
      if (mins == null) return null;
      const days = repeat.kind === 'weekly' ? new Set((repeat.days || []).map(Number)) : null;
      if (days && !days.size) return null;
      for (let d = 0; d <= 7; d++) {
        const t = atMinutes(now, d, mins);
        if (t > from && (!days || days.has(new Date(t).getDay()))) return t;
      }
      return null;
    }
    default:
      return null;
  }
}

// Is `now` inside the daily window start..end? Windows may cross midnight (23:00 - 06:00).
function inWindow(now, start, end) {
  const s = parseTime(start);
  const e = parseTime(end);
  if (s == null || e == null || s === e) return true;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

class Scheduler {
  // run(job) => Promise<string | void>: does the work, resolves to a short result message.
  constructor({ file, run, now = () => Date.now(), onChange = () => {} }) {
    this.file = file;
    this.runJob = run;
    this.now = now;
    this.onChange = onChange;
    this.jobs = [];
    this.running = new Set();
    this.timer = null;
    try {
      this.jobs = JSON.parse(fs.readFileSync(file, 'utf8')).jobs || [];
    } catch {
      // no schedule yet
    }
  }

  list() {
    return this.jobs.map((j) => ({ ...j, running: this.running.has(j.id) }));
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2));
    this.onChange(this.list());
  }

  // Creates or updates a job. Its next run is computed from now.
  save(input) {
    const existing = input.id && this.jobs.find((j) => j.id === input.id);
    const job = {
      id: existing ? existing.id : crypto.randomUUID(),
      name: String(input.name || '').trim() || 'Lịch mới',
      enabled: input.enabled !== false,
      type: input.type,
      params: input.params,
      repeat: input.repeat,
      lastRun: existing ? existing.lastRun : null,
      lastResult: existing ? existing.lastResult : null,
    };
    if (!['download', 'sync'].includes(job.type)) throw new Error('Loại lịch không hợp lệ.');
    job.nextRun = job.enabled ? nextRun(job.repeat, this.now()) : null;
    if (job.enabled && job.nextRun == null) throw new Error('Thời điểm chạy không hợp lệ hoặc đã qua.');
    if (existing) this.jobs[this.jobs.indexOf(existing)] = job;
    else this.jobs.push(job);
    this._save();
    return job;
  }

  remove(id) {
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this._save();
  }

  setEnabled(id, enabled) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    j.enabled = enabled;
    j.nextRun = enabled ? nextRun(j.repeat, this.now()) : null;
    if (enabled && j.nextRun == null) {
      j.enabled = false;
      throw new Error('Lịch này không còn lần chạy nào phía trước. Hãy sửa lại thời gian.');
    }
    this._save();
  }

  start(intervalMs = 20_000) {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Runs every job that is due. A job missed while the app was closed runs once, right away.
  tick() {
    const t = this.now();
    for (const job of this.jobs) {
      if (job.enabled && job.nextRun != null && job.nextRun <= t && !this.running.has(job.id)) this.execute(job);
    }
  }

  runNow(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error('Không tìm thấy lịch.');
    if (this.running.has(id)) throw new Error('Lịch này đang chạy.');
    return this.execute(job, { manual: true });
  }

  async execute(job, { manual = false } = {}) {
    this.running.add(job.id);
    const started = this.now();
    if (!manual) {
      // Reschedule before running so a slow or failing job can never re-fire in a loop.
      job.nextRun = nextRun(job.repeat, started);
      if (job.nextRun == null) job.enabled = false;
    }
    this.onChange(this.list());
    let result;
    try {
      const message = await this.runJob(job);
      result = { ok: true, message: message || 'Đã chạy xong.' };
    } catch (e) {
      result = { ok: false, message: e.message || String(e) };
    }
    job.lastRun = started;
    job.lastResult = result;
    this.running.delete(job.id);
    this._save();
    return result;
  }
}

module.exports = { nextRun, inWindow, parseTime, Scheduler };
