'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nextRun, inWindow, Scheduler } = require('../src/main/schedule');

// local-time helper: 2026-09-29 is a Tuesday
const at = (d, h, m = 0) => new Date(2026, 8, d, h, m, 0, 0).getTime();

test('daily: later today, else tomorrow', () => {
  assert.equal(nextRun({ kind: 'daily', time: '23:00' }, at(29, 10)), at(29, 23));
  assert.equal(nextRun({ kind: 'daily', time: '08:30' }, at(29, 10)), at(30, 8, 30));
  assert.equal(nextRun({ kind: 'daily', time: '10:00' }, at(29, 10)), at(30, 10), 'strictly after now');
});

test('weekly: next chosen weekday, including across the week boundary', () => {
  // Tue 29 Sep 2026; days: Monday(1) and Friday(5)
  const rep = { kind: 'weekly', time: '06:00', days: [1, 5] };
  assert.equal(nextRun(rep, at(29, 10)), at(32, 6)); // Fri 2 Oct (day 32 = 2 Oct)
  assert.equal(nextRun(rep, at(32, 7)), at(35, 6)); // after Fri -> Mon 5 Oct
  assert.equal(nextRun({ kind: 'weekly', time: '06:00', days: [] }, at(29, 10)), null);
});

test('once and interval', () => {
  assert.equal(nextRun({ kind: 'once', at: at(30, 1) }, at(29, 10)), at(30, 1));
  assert.equal(nextRun({ kind: 'once', at: at(28, 1) }, at(29, 10)), null);
  assert.equal(nextRun({ kind: 'interval', minutes: 90 }, at(29, 10)), at(29, 11, 30));
  assert.equal(nextRun({ kind: 'daily', time: '25:00' }, at(29, 10)), null);
});

test('window that crosses midnight', () => {
  assert.equal(inWindow(at(29, 23, 30), '23:00', '06:00'), true);
  assert.equal(inWindow(at(30, 2), '23:00', '06:00'), true);
  assert.equal(inWindow(at(29, 12), '23:00', '06:00'), false);
  assert.equal(inWindow(at(29, 6), '23:00', '06:00'), false, 'end is exclusive');
  assert.equal(inWindow(at(29, 12), '09:00', '17:00'), true);
  assert.equal(inWindow(at(29, 12), '', ''), true, 'no window means always');
});

function makeScheduler(runImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-sch-'));
  const clock = { t: at(29, 10) };
  const runs = [];
  const s = new Scheduler({ file: path.join(dir, 's.json'), now: () => clock.t, run: async (job) => { runs.push(job.name); return runImpl ? runImpl(job) : 'ok'; } });
  return { s, clock, runs, dir };
}
const params = { links: 'x', destDir: '/tmp' };

test('runs due jobs once, reschedules, and records the result', async () => {
  const { s, clock, runs } = makeScheduler();
  const job = s.save({ name: 'Đêm', type: 'download', params, repeat: { kind: 'daily', time: '23:00' } });
  s.tick();
  assert.deepEqual(runs, []);
  clock.t = at(29, 23, 0);
  s.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(runs, ['Đêm']);
  const j = s.jobs[0];
  assert.equal(j.nextRun, at(30, 23));
  assert.equal(j.lastResult.ok, true);
  s.tick(); // not due again
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs.length, 1);
  assert.ok(job.id);
});

test('a missed run fires once on the next tick; one-off jobs disable themselves; failures are recorded', async () => {
  const { s, clock, runs } = makeScheduler((job) => {
    if (job.name === 'lỗi') throw new Error('Hết dung lượng');
  });
  s.save({ name: 'một lần', type: 'sync', params: {}, repeat: { kind: 'once', at: at(29, 12) } });
  s.save({ name: 'lỗi', type: 'sync', params: {}, repeat: { kind: 'interval', minutes: 60 } });
  clock.t = at(30, 9); // the app was closed for a day
  s.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([...runs].sort(), ['lỗi', 'một lần']);
  const once = s.jobs.find((j) => j.name === 'một lần');
  assert.equal(once.enabled, false);
  assert.equal(once.nextRun, null);
  const bad = s.jobs.find((j) => j.name === 'lỗi');
  assert.equal(bad.lastResult.ok, false);
  assert.match(bad.lastResult.message, /Hết dung lượng/);
  assert.equal(bad.nextRun, at(30, 10), 'rescheduled from the missed run, not replayed');
});

test('persists across restarts and validates input', () => {
  const { s, dir } = makeScheduler();
  s.save({ name: 'a', type: 'download', params, repeat: { kind: 'daily', time: '07:00' } });
  const again = new Scheduler({ file: path.join(dir, 's.json'), run: async () => {} });
  assert.equal(again.jobs.length, 1);
  assert.throws(() => s.save({ name: 'x', type: 'nope', params, repeat: { kind: 'daily', time: '07:00' } }), /không hợp lệ/);
  assert.throws(() => s.save({ name: 'x', type: 'sync', params, repeat: { kind: 'once', at: 1 } }), /đã qua/);
});
