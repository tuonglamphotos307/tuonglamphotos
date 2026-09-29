'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createRunners, downloadSpec, PART_EXT } = require('../src/main/transfers');
const { FOLDER_MIME } = require('../src/main/drive');

const CONTENT = crypto.randomBytes(300_000);
const MD5 = crypto.createHash('md5').update(CONTENT).digest('hex');
const META = { id: 'f1', name: 'photo:1.jpg', mimeType: 'image/jpeg', size: String(CONTENT.length), md5Checksum: MD5, modifiedTime: '2024-05-01T10:00:00Z' };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dd-t-'));

function settings(overrides = {}) {
  const s = { conflict: 'rename', verifyMd5: true, exportFormat: 'office', uploadChunkMB: 1, ...overrides };
  return { get: (k) => s[k] };
}

function ctxFor(task) {
  const enqueued = [];
  const ctrl = new AbortController();
  return {
    enqueued,
    ctrl,
    signal: ctrl.signal,
    progress: (b, size) => Object.assign(task, { transferred: b, ...(size !== undefined ? { size } : {}) }),
    update: (p) => Object.assign(task, p),
    enqueue: (specs) => enqueued.push(...specs),
  };
}

// A body that sends `limit` bytes then fails like a dropped connection.
function brokenBody(buf, limit) {
  let sent = false;
  return new ReadableStream({
    async pull(c) {
      if (!sent) {
        sent = true;
        c.enqueue(new Uint8Array(buf.subarray(0, limit)));
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
      c.error(Object.assign(new Error('terminated'), { code: 'ECONNRESET' }));
    },
  });
}

function fakeDrive(opts = {}) {
  const calls = { media: [] };
  return {
    calls,
    get: async () => META,
    resolveShortcut: async (f) => f,
    media: async (id, { start = 0 }) => {
      calls.media.push(start);
      const body = opts.breakAt && calls.media.length === 1 ? brokenBody(CONTENT.subarray(start), opts.breakAt) : CONTENT.subarray(start);
      return new Response(body, { status: start ? 206 : 200 });
    },
    list: async () => [
      { id: 'a', name: 'a.txt', mimeType: 'text/plain', size: '3' },
      { id: 'sub', name: 'Sub', mimeType: FOLDER_MIME },
    ],
  };
}

test('downloads, verifies md5, sanitizes the name and sets mtime', async () => {
  const dir = tmp();
  const drive = fakeDrive();
  const { runners } = createRunners({ drive, settings: settings() });
  const task = downloadSpec(META, dir);
  await runners.download(task, ctxFor(task));
  const out = path.join(dir, 'photo_1.jpg');
  assert.ok(fs.readFileSync(out).equals(CONTENT));
  assert.equal(fs.statSync(out).mtime.toISOString(), '2024-05-01T10:00:00.000Z');
  assert.ok(!fs.existsSync(out + PART_EXT));
});

test('resumes after a dropped connection', async () => {
  const dir = tmp();
  const drive = fakeDrive({ breakAt: 120_000 });
  const { runners } = createRunners({ drive, settings: settings() });
  const task = downloadSpec(META, dir);
  await assert.rejects(runners.download(task, ctxFor(task)), (e) => e.retryable === true);
  assert.equal(fs.statSync(task.partPath).size, 120_000);
  await runners.download(task, ctxFor(task));
  assert.deepEqual(drive.calls.media, [0, 120_000]);
  assert.ok(fs.readFileSync(task.finalPath).equals(CONTENT));
});

test('renames on conflict, or skips when configured', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'photo_1.jpg'), 'old');
  const { runners } = createRunners({ drive: fakeDrive(), settings: settings() });
  const task = downloadSpec(META, dir);
  await runners.download(task, ctxFor(task));
  assert.equal(path.basename(task.finalPath), 'photo_1 (1).jpg');
  assert.equal(fs.readFileSync(path.join(dir, 'photo_1.jpg'), 'utf8'), 'old');

  const skip = createRunners({ drive: fakeDrive(), settings: settings({ conflict: 'skip' }) }).runners;
  const t2 = downloadSpec(META, dir);
  const r = await skip.download(t2, ctxFor(t2));
  assert.equal(r.status, 'skipped');
});

test('md5 mismatch discards the file and asks for a retry', async () => {
  const dir = tmp();
  const { runners } = createRunners({ drive: fakeDrive(), settings: settings() });
  const task = downloadSpec({ ...META, md5Checksum: 'deadbeef' }, dir);
  await assert.rejects(runners.download(task, ctxFor(task)), (e) => e.retryable && /MD5/.test(e.message));
  assert.ok(!fs.existsSync(task.partPath));
});

test('folder download creates the folder and enqueues children', async () => {
  const dir = tmp();
  const { runners } = createRunners({ drive: fakeDrive(), settings: settings() });
  const task = downloadSpec({ id: 'root1', name: 'Album', mimeType: FOLDER_MIME }, dir);
  const ctx = ctxFor(task);
  const r = await runners.download(task, ctx);
  assert.ok(fs.statSync(path.join(dir, 'Album')).isDirectory());
  assert.equal(ctx.enqueued.length, 2);
  assert.equal(ctx.enqueued[0].destDir, path.join(dir, 'Album'));
  assert.equal(ctx.enqueued[1].isFolder, true);
  assert.match(r.note, /1 file, 1 thư mục/);
});

function fakeUploadDrive({ existing = [], sessionOffset = null } = {}) {
  const calls = { chunks: [], started: [] };
  let received = [];
  return {
    calls,
    get received() {
      return Buffer.concat(received);
    },
    findChild: async (_p, name) => existing.filter((e) => e.name === name),
    startUpload: async (args) => {
      calls.started.push(args);
      return 'https://upload.example/session';
    },
    queryUpload: async () => ({ done: false, offset: sessionOffset }),
    uploadChunk: async (_uri, { iterable, start, end, size }) => {
      const parts = [];
      for await (const b of iterable) parts.push(b);
      const buf = Buffer.concat(parts);
      assert.equal(buf.length, end - start);
      received.push(buf);
      calls.chunks.push([start, end]);
      return end === size ? { done: true, file: { id: 'new-id' } } : { done: false, offset: end };
    },
  };
}

test('uploads in chunks through a resumable session', async () => {
  const dir = tmp();
  const file = path.join(dir, 'big.bin');
  const data = crypto.randomBytes(2.5 * 1024 * 1024);
  fs.writeFileSync(file, data);
  const drive = fakeUploadDrive({ existing: [{ name: 'big.bin', id: 'x', mimeType: 'application/octet-stream' }] });
  const { runners } = createRunners({ drive, settings: settings() });
  const task = { type: 'upload', localPath: file, name: 'big.bin', parentId: 'p1' };
  await runners.upload(task, ctxFor(task));
  const MB = 1024 * 1024;
  assert.deepEqual(drive.calls.chunks, [[0, MB], [MB, 2 * MB], [2 * MB, data.length]]);
  assert.ok(drive.received.equals(data));
  assert.equal(task.driveFileId, 'new-id');
  assert.equal(drive.calls.started[0].name, 'big (1).bin', 'conflict should rename');
});

test('resumes an upload from the offset the session reports', async () => {
  const dir = tmp();
  const file = path.join(dir, 'big.bin');
  const data = crypto.randomBytes(2 * 1024 * 1024 + 10);
  fs.writeFileSync(file, data);
  const st = fs.statSync(file);
  const drive = fakeUploadDrive({ sessionOffset: 1024 * 1024 });
  const { runners } = createRunners({ drive, settings: settings() });
  const task = { type: 'upload', localPath: file, name: 'big.bin', parentId: 'p1', sessionUri: 'https://upload.example/session', sessionSize: st.size, sessionMtime: st.mtimeMs };
  await runners.upload(task, ctxFor(task));
  assert.equal(drive.calls.started.length, 0);
  assert.equal(drive.calls.chunks[0][0], 1024 * 1024);
  assert.ok(drive.received.equals(data.subarray(1024 * 1024)));
});
