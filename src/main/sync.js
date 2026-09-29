'use strict';

// Non-destructive two-way folder comparison between a local folder and a Drive folder.
// Only copies what is missing on one side; nothing is ever deleted. Files that exist on both sides
// with different content are reported as "differ" and only replaced when the user opts in.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FOLDER_MIME, SHORTCUT_MIME, isGoogleNative } = require('./drive');
const { PART_EXT } = require('./transfers');

const MTIME_SLACK_MS = 2000;
const fold = (s) => s.normalize('NFC').toLowerCase();

async function md5Local(file) {
  const hash = crypto.createHash('md5');
  for await (const buf of fs.createReadStream(file)) hash.update(buf);
  return hash.digest('hex');
}

async function listLocal(dir) {
  const out = new Map();
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (e.name.endsWith(PART_EXT) || e.name.startsWith('.')) continue;
    if (!e.isFile() && !e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    const st = await fs.promises.stat(full).catch(() => null);
    if (!st) continue;
    out.set(fold(e.name), { name: e.name, path: full, isDir: e.isDirectory(), size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

async function listRemote(drive, folder, signal) {
  const out = new Map();
  const skipped = [];
  for (const f of await drive.list({ id: folder.id, driveId: folder.driveId, resourceKey: folder.resourceKey }, { signal })) {
    if (isGoogleNative(f.mimeType) || f.mimeType === SHORTCUT_MIME) {
      skipped.push(f.name);
      continue;
    }
    const key = fold(f.name);
    if (out.has(key)) continue; // Drive allows duplicate names; the first one wins
    out.set(key, { ...f, isDir: f.mimeType === FOLDER_MIME, size: f.size != null ? Number(f.size) : null, mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : null });
  }
  return { map: out, skipped };
}

async function sameContent(local, remote) {
  if (local.size !== remote.size) return false;
  if (remote.mtime != null && Math.abs(local.mtime - remote.mtime) <= MTIME_SLACK_MS) return true;
  if (remote.md5Checksum) return (await md5Local(local.path)) === remote.md5Checksum;
  return true; // same size, no checksum to compare: treat as equal
}

// Returns { upload, download, differ, same, skipped, conflicts, totals }.
async function buildPlan({ drive, localDir, folder, signal, onProgress }) {
  const plan = { upload: [], download: [], differ: [], same: 0, skipped: [], conflicts: [] };
  let scanned = 0;

  async function walk(dir, remoteFolder, rel) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const [local, remote] = await Promise.all([listLocal(dir), listRemote(drive, remoteFolder, signal)]);
    plan.skipped.push(...remote.skipped.map((n) => path.posix.join(rel, n)));
    onProgress && onProgress(++scanned);

    for (const [key, l] of local) {
      const r = remote.map.get(key);
      const relPath = path.posix.join(rel, l.name);
      if (!r) {
        plan.upload.push({ rel: relPath, isDir: l.isDir, localPath: l.path, size: l.isDir ? null : l.size, parentId: remoteFolder.id, driveId: remoteFolder.driveId || null, name: l.name });
      } else if (l.isDir && r.isDir) {
        await walk(l.path, { id: r.id, driveId: remoteFolder.driveId || r.driveId || null, resourceKey: r.resourceKey || null }, relPath);
      } else if (l.isDir !== r.isDir) {
        plan.conflicts.push(relPath);
      } else if (await sameContent(l, r)) {
        plan.same++;
      } else {
        plan.differ.push({ rel: relPath, local: l, remote: r, newer: (l.mtime || 0) >= (r.mtime || 0) ? 'local' : 'remote', driveId: remoteFolder.driveId || null, parentId: remoteFolder.id, destDir: dir });
      }
    }
    for (const [key, r] of remote.map) {
      if (local.has(key)) continue;
      plan.download.push({ rel: path.posix.join(rel, r.name), isDir: r.isDir, item: r, destDir: dir, size: r.isDir ? null : r.size });
    }
  }

  await walk(localDir, folder, '');
  const sum = (arr) => arr.reduce((s, x) => s + (x.size || 0), 0);
  plan.totals = { uploadBytes: sum(plan.upload), downloadBytes: sum(plan.download) };
  return plan;
}

module.exports = { buildPlan };
