'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { buildPlan } = require('../src/main/sync');
const { FOLDER_MIME } = require('../src/main/drive');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const T0 = Date.parse('2024-01-01T00:00:00Z');

function makeLocal(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-sync-'));
  for (const [rel, [content, mtime]] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    fs.utimesSync(p, new Date(mtime), new Date(mtime));
  }
  return dir;
}

// tree: { folderId: [items] }
function fakeDrive(tree) {
  return { list: async ({ id }) => tree[id] || [] };
}
const file = (name, content, mtime = T0, extra = {}) => ({ id: `id-${name}`, name, mimeType: 'text/plain', size: String(Buffer.byteLength(content)), md5Checksum: md5(content), modifiedTime: new Date(mtime).toISOString(), ...extra });
const folder = (name, id) => ({ id, name, mimeType: FOLDER_MIME });

test('finds what is missing on each side and what matches', async () => {
  const dir = makeLocal({
    'same.txt': ['hello', T0],
    'only-local.txt': ['abc', T0],
    'new-dir/a.txt': ['a', T0],
    'sub/inner-same.txt': ['x', T0],
    'sub/inner-local.txt': ['y', T0],
  });
  const drive = fakeDrive({
    root: [file('same.txt', 'hello'), file('only-drive.txt', 'zzz'), folder('sub', 'sub1'), folder('drive-dir', 'dd1')],
    sub1: [file('inner-same.txt', 'x'), file('inner-drive.txt', 'q')],
  });
  const plan = await buildPlan({ drive, localDir: dir, folder: { id: 'root' } });
  assert.deepEqual(plan.upload.map((u) => u.rel).sort(), ['new-dir', 'only-local.txt', 'sub/inner-local.txt']);
  assert.deepEqual(plan.download.map((d) => d.rel).sort(), ['drive-dir', 'only-drive.txt', 'sub/inner-drive.txt']);
  assert.equal(plan.same, 2);
  assert.equal(plan.differ.length, 0);
  assert.equal(plan.upload.find((u) => u.rel === 'sub/inner-local.txt').parentId, 'sub1');
  assert.equal(plan.upload.find((u) => u.rel === 'new-dir').isDir, true);
  assert.equal(plan.download.find((d) => d.rel === 'sub/inner-drive.txt').destDir, path.join(dir, 'sub'));
});

test('differing files report which side is newer; same size + different bytes uses md5', async () => {
  const dir = makeLocal({
    'edited.txt': ['new local text', T0 + 86_400_000],
    'swapped.txt': ['AAAA', T0 + 60_000],
  });
  const drive = fakeDrive({
    root: [file('edited.txt', 'old text', T0), file('swapped.txt', 'BBBB', T0)],
  });
  const plan = await buildPlan({ drive, localDir: dir, folder: { id: 'root' } });
  assert.equal(plan.differ.length, 2);
  assert.equal(plan.differ.find((d) => d.rel === 'edited.txt').newer, 'local');
  assert.equal(plan.differ.find((d) => d.rel === 'swapped.txt').newer, 'local');
  assert.equal(plan.same, 0);
});

test('names match ignoring case; Google docs, shortcuts and file/folder clashes are skipped', async () => {
  const dir = makeLocal({ 'Photo.JPG': ['p', T0], 'thing/x.txt': ['x', T0] });
  const drive = fakeDrive({
    root: [
      file('photo.jpg', 'p'),
      { id: 'g1', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet' },
      { id: 's1', name: 'link', mimeType: 'application/vnd.google-apps.shortcut' },
      file('thing', 'i am a file'),
    ],
  });
  const plan = await buildPlan({ drive, localDir: dir, folder: { id: 'root' } });
  assert.equal(plan.same, 1);
  assert.equal(plan.download.length, 0);
  assert.equal(plan.skipped.length, 2);
  assert.deepEqual(plan.conflicts, ['thing']);
});
