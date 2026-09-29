'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeBatch, formatBatch, fmtBytes } = require('../src/main/notify');

const T = 1_000;
const tasks = [
  { type: 'download', status: 'done', size: 3 * 1024 * 1024, finishedAt: T + 5 },
  { type: 'download', status: 'done', size: 1024 * 1024, finishedAt: T + 6 },
  { type: 'upload', status: 'done', size: 2 * 1024 * 1024, finishedAt: T + 7 },
  { type: 'download', status: 'done', size: 999, finishedAt: T - 1 }, // an earlier batch
  { type: 'download', status: 'done', isFolder: true, size: null, finishedAt: T + 1 }, // scan step
  { type: 'upload', status: 'skipped', finishedAt: T + 8 },
  { type: 'download', status: 'error', error: 'Hết dung lượng' },
];

test('summarizes only this batch and ignores folder scan steps', () => {
  assert.deepEqual(summarizeBatch(tasks, T), { down: 2, up: 1, skipped: 1, errors: 1, bytes: 6 * 1024 * 1024, firstError: 'Hết dung lượng' });
});

test('message text', () => {
  const m = formatBatch(summarizeBatch(tasks, T));
  assert.equal(m.title, 'DriveDock: xong, có file lỗi');
  assert.match(m.body, /2 file đã tải về · 1 file đã tải lên · 6 MB/);
  assert.match(m.body, /1 file lỗi: Hết dung lượng/);
  const ok = formatBatch(summarizeBatch(tasks.slice(0, 3), T));
  assert.equal(ok.title, 'DriveDock: đã xong');
  assert.equal(formatBatch(summarizeBatch([], T)), null);
  assert.equal(formatBatch(summarizeBatch([{ type: 'upload', status: 'skipped', finishedAt: T + 1 }], T)), null, 'only skips: stay quiet');
});

test('byte formatting uses a decimal comma', () => {
  assert.equal(fmtBytes(1536), '1,5 KB');
  assert.equal(fmtBytes(0), '0 B');
});
