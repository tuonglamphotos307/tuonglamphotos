'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TransferQueue } = require('../src/main/queue');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await wait(10);
  }
  throw new Error('timeout');
}

// A runner that "transfers" until aborted or until the test releases it.
function controllable() {
  const gates = new Map();
  const runner = (task, ctx) =>
    new Promise((resolve, reject) => {
      gates.set(task.name, resolve);
      ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
      ctx.progress(1, 10);
    });
  return { runner, gates };
}

test('respects concurrency and runs in order', async () => {
  const { runner, gates } = controllable();
  const q = new TransferQueue({ runners: { download: runner }, getConcurrency: () => 2 });
  q.add(['a', 'b', 'c'].map((name) => ({ type: 'download', name })));
  await until(() => gates.size === 2);
  assert.deepEqual([...gates.keys()], ['a', 'b']);
  gates.get('a')();
  await until(() => gates.has('c'));
  const byName = Object.fromEntries([...q.tasks.values()].map((t) => [t.name, t.status]));
  assert.equal(byName.a, 'done');
  assert.equal(byName.c, 'running');
  q.cancel('all');
});

test('pause, resume and cancel', async () => {
  const { runner, gates } = controllable();
  const canceled = [];
  const q = new TransferQueue({ runners: { download: runner }, hooks: { onCancel: (t) => canceled.push(t.name) }, getConcurrency: () => 1 });
  const [a] = q.add([{ type: 'download', name: 'a' }]);
  await until(() => gates.has('a'));
  q.pause([a.id]);
  await until(() => q.tasks.get(a.id).status === 'paused' && !q.live.size);
  gates.clear();
  q.resume([a.id]);
  await until(() => gates.has('a'));
  assert.equal(q.tasks.get(a.id).status, 'running');
  q.cancel([a.id]);
  await until(() => canceled.includes('a'));
  assert.equal(q.tasks.get(a.id).status, 'canceled');
});

test('retries retryable errors, fails others', async () => {
  let calls = 0;
  const q = new TransferQueue({
    runners: {
      download: async (task) => {
        calls++;
        if (task.name === 'flaky' && calls < 2) throw Object.assign(new Error('reset'), { retryable: true });
        if (task.name === 'bad') throw new Error('nope');
      },
    },
    getConcurrency: () => 1,
  });
  const [flaky, bad] = q.add([{ type: 'download', name: 'flaky' }, { type: 'download', name: 'bad' }]);
  await until(() => q.tasks.get(flaky.id).status === 'done', 6000);
  await until(() => q.tasks.get(bad.id).status === 'error');
  assert.equal(q.tasks.get(bad.id).error, 'nope');
});

test('children are enqueued right after their folder', async () => {
  const order = [];
  const q = new TransferQueue({
    runners: {
      download: async (task, ctx) => {
        order.push(task.name);
        if (task.name === 'folder') ctx.enqueue([{ type: 'download', name: 'child1' }, { type: 'download', name: 'child2' }]);
      },
    },
    getConcurrency: () => 1,
  });
  q.add([{ type: 'download', name: 'folder' }, { type: 'download', name: 'later' }]);
  await until(() => order.length === 4);
  assert.deepEqual(order, ['folder', 'child1', 'child2', 'later']);
});

test('persists and restores unfinished tasks as paused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-q-'));
  const file = path.join(dir, 'queue.json');
  const { runner, gates } = controllable();
  const q = new TransferQueue({ file, runners: { download: runner } });
  q.add([{ type: 'download', name: 'a' }]);
  await until(() => gates.has('a'));
  q.shutdown();
  const q2 = new TransferQueue({ file, runners: { download: runner } });
  assert.equal([...q2.tasks.values()][0].status, 'paused');
  const q3 = new TransferQueue({ file, runners: { download: runner }, getAutoResume: () => true });
  assert.equal([...q3.tasks.values()][0].status, 'queued');
});
