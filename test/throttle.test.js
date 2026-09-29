'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Throttle } = require('../src/main/throttle');

test('unlimited never waits', async () => {
  const t = new Throttle(() => 0);
  const start = Date.now();
  for (let i = 0; i < 50; i++) await t.take(10 * 1024 * 1024);
  assert.ok(Date.now() - start < 100);
});

test('paces concurrent callers to the shared rate', { timeout: 15000 }, async () => {
  const t = new Throttle(() => 1_000_000); // 1 MB/s
  const start = Date.now();
  // 4 "connections" x 5 chunks x 100 kB = 2 MB -> about 2 s in total
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let i = 0; i < 5; i++) await t.take(100_000);
  }));
  const took = Date.now() - start;
  assert.ok(took >= 1700 && took < 2600, `took ${took} ms`);
});

test('rate changes apply immediately and abort works', async () => {
  let rate = 10_000;
  const t = new Throttle(() => rate);
  await t.take(10_000); // reserves a full second on the link
  const ctrl = new AbortController();
  const waiting = t.take(10_000, ctrl.signal);
  ctrl.abort(new Error('stop'));
  await assert.rejects(waiting, /stop/);
  rate = 0;
  const start = Date.now();
  await t.take(1e9);
  assert.ok(Date.now() - start < 50);
});
