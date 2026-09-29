'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { downloadSegmented, planSegments, MIN_SPLIT } = require('../src/main/segmented');
const { createRunners, downloadSpec } = require('../src/main/transfers');
const { DriveError } = require('../src/main/drive');

const MB = 1024 * 1024;
const CONTENT = crypto.randomBytes(24 * MB);
const MD5 = crypto.createHash('md5').update(CONTENT).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dd-s-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Streams buf in 256 KiB chunks; `delay(offset)` ms before each chunk, `failAt` absolute offset to drop the connection.
function body(buf, base, { delay = () => 0, failAt = null } = {}) {
  let off = 0;
  return new ReadableStream({
    async pull(c) {
      if (off >= buf.length) return c.close();
      if (failAt != null && base + off >= failAt) return c.error(Object.assign(new Error('terminated'), { code: 'ECONNRESET' }));
      const d = delay(base + off);
      if (d) await sleep(d);
      const n = Math.min(256 * 1024, buf.length - off);
      c.enqueue(new Uint8Array(buf.subarray(off, off + n)));
      off += n;
    },
  });
}

function rangeDrive(opts = {}) {
  const calls = [];
  return {
    calls,
    media: async (_id, { start = 0, end = null, signal }) => {
      calls.push([start, end]);
      if (opts.noRange) return new Response(body(CONTENT, 0), { status: 200 });
      const last = end == null ? CONTENT.length - 1 : end;
      const slice = CONTENT.subarray(start, last + 1);
      const failAt = opts.failAt && calls.length <= opts.failOnCalls ? opts.failAt : null;
      const stream = body(slice, start, { delay: opts.delay, failAt });
      signal?.addEventListener('abort', () => stream.cancel().catch(() => {}), { once: true });
      return new Response(stream, { status: 206 });
    },
    get: async () => ({ id: 'big', name: 'big.mov', mimeType: 'video/quicktime', size: String(CONTENT.length), md5Checksum: MD5 }),
    resolveShortcut: async (f) => f,
  };
}

function ctxFor(task) {
  const ctrl = new AbortController();
  return {
    signal: ctrl.signal,
    progress: (b, size) => Object.assign(task, { transferred: b, size }),
    update: (p) => Object.assign(task, p),
    enqueue: () => {},
  };
}

const markRetryable = (e) => (e instanceof DriveError ? e : Object.assign(new DriveError(e.message), { retryable: true }));

test('plans ranges no smaller than the split minimum', () => {
  assert.equal(planSegments(3 * MB, 8).length, 1);
  const segs = planSegments(24 * MB, 4);
  assert.equal(segs.length, 4);
  assert.equal(segs[3].end, 24 * MB);
  assert.ok(segs.every((s) => s.end - s.start >= MIN_SPLIT));
});

test('downloads over several connections and steals work from the slow one', { timeout: 30000 }, async () => {
  const dir = tmp();
  // The first half of the file trickles in; the second half is instant.
  const drive = rangeDrive({ delay: (off) => (off < 12 * MB ? 15 : 0) });
  const task = { fileId: 'big', size: CONTENT.length, partPath: path.join(dir, 'big.part') };
  const ok = await downloadSegmented(task, ctxFor(task), { drive, connections: 2, markRetryable });
  assert.equal(ok, true);
  assert.ok(fs.readFileSync(task.partPath).equals(CONTENT));
  assert.ok(drive.calls.length > 2, `expected work stealing, got ${JSON.stringify(drive.calls)}`);
  assert.equal(task.transferred, CONTENT.length);
  assert.equal(task.segments, null);
});

test('resumes every range after a dropped connection', { timeout: 30000 }, async () => {
  const dir = tmp();
  const task = { fileId: 'big', size: CONTENT.length, partPath: path.join(dir, 'big.part') };
  const flaky = rangeDrive({ failAt: 3 * MB, failOnCalls: 4 });
  await assert.rejects(downloadSegmented(task, ctxFor(task), { drive: flaky, connections: 4, markRetryable }), (e) => e.retryable);
  assert.ok(Array.isArray(task.segments));
  const done = task.segments.reduce((s, x) => s + (x.pos - x.start), 0);
  assert.ok(done > 0, 'some bytes were kept');

  const drive = rangeDrive();
  const ok = await downloadSegmented(task, ctxFor(task), { drive, connections: 4, markRetryable });
  assert.equal(ok, true);
  assert.ok(drive.calls.some(([start]) => start > 0 && start % (6 * MB) !== 0), 'restarted mid-range');
  assert.ok(fs.readFileSync(task.partPath).equals(CONTENT));
});

test('runner uses segments for big files and verifies md5', { timeout: 30000 }, async () => {
  const dir = tmp();
  const drive = rangeDrive();
  const s = { conflict: 'rename', verifyMd5: true, exportFormat: 'office', connectionsPerFile: 4 };
  const { runners } = createRunners({ drive, settings: { get: (k) => s[k] } });
  const task = downloadSpec(await drive.get(), dir);
  const r = await runners.download(task, ctxFor(task));
  assert.match(r.note, /4 kết nối/);
  assert.ok(fs.readFileSync(path.join(dir, 'big.mov')).equals(CONTENT));
});

test('falls back to one stream when the server ignores Range', { timeout: 30000 }, async () => {
  const dir = tmp();
  const drive = rangeDrive({ noRange: true });
  const s = { conflict: 'rename', verifyMd5: true, exportFormat: 'office', connectionsPerFile: 4 };
  const { runners } = createRunners({ drive, settings: { get: (k) => s[k] } });
  const task = downloadSpec(await drive.get(), dir);
  await runners.download(task, ctxFor(task));
  assert.equal(task.noSegments, true);
  assert.ok(fs.readFileSync(path.join(dir, 'big.mov')).equals(CONTENT));
});
