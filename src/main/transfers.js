'use strict';

// Task runners for the transfer queue: Drive -> local downloads and local -> Drive uploads.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { DriveError, FOLDER_MIME, SHORTCUT_MIME, isGoogleNative, exportTarget, parseContentDisposition } = require('./drive');
const { sanitizeName, exists, uniquePath } = require('./fsutil');
const { downloadSegmented } = require('./segmented');

const PART_EXT = '.drivedock-part';
const PROGRESS_INTERVAL_MS = 200;
// Files at least this big are fetched over several connections (Settings → connectionsPerFile).
const SEGMENTED_MIN_SIZE = 16 * 1024 * 1024;

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.psd': 'image/vnd.adobe.photoshop', '.cr2': 'image/x-canon-cr2', '.cr3': 'image/x-canon-cr3', '.nef': 'image/x-nikon-nef',
  '.arw': 'image/x-sony-arw', '.dng': 'image/x-adobe-dng',
};

const mimeFor = (name) => MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream';

// Network hiccups mid-stream are worth retrying: the next attempt resumes from where it stopped.
function markRetryable(err, signal) {
  if (signal.aborted) return err;
  if (err instanceof DriveError) return err;
  const code = err && (err.code || err.cause?.code);
  const transient = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_STREAM_PREMATURE_CLOSE'];
  if (transient.includes(code) || /terminated|socket|network|fetch failed/i.test(err?.message || '')) {
    const e = new DriveError(`Mất kết nối (${code || err.message}), sẽ tự tiếp tục.`, { retryable: true });
    return e;
  }
  return err;
}

function progressThrottle(ctx) {
  let last = 0;
  return (bytes, size, force) => {
    const now = Date.now();
    if (force || now - last >= PROGRESS_INTERVAL_MS) {
      last = now;
      ctx.progress(bytes, size);
    }
  };
}

// Hashes an existing partial file so a resumed download can still be verified end to end.
async function md5File(file, signal) {
  const hash = crypto.createHash('md5');
  for await (const buf of fs.createReadStream(file, { signal })) hash.update(buf);
  return hash;
}

function createRunners({ drive, settings }) {
  // ---------------------------------------------------------------- downloads

  async function scanDriveFolder(task, ctx) {
    const localDir = task.localDir || path.join(task.destDir, sanitizeName(task.name));
    await fs.promises.mkdir(localDir, { recursive: true });
    ctx.update({ localDir, dest: localDir, note: 'Đang quét thư mục…' });

    const children = await drive.list({ id: task.fileId, driveId: task.driveId, resourceKey: task.resourceKey }, { signal: ctx.signal });
    let files = 0;
    let folders = 0;
    const specs = children.map((c) => {
      const isFolder = c.mimeType === FOLDER_MIME;
      if (isFolder) folders++;
      else files++;
      return downloadSpec(c, localDir, { resolved: c.mimeType !== SHORTCUT_MIME, sourcePrefix: task.source });
    });
    if (specs.length) ctx.enqueue(specs);
    return { note: `${files} file, ${folders} thư mục con` };
  }

  async function resolveMeta(task, ctx) {
    if (task.resolved) return task;
    let meta = await drive.get(task.fileId, task.resourceKey);
    meta = await drive.resolveShortcut(meta);
    const patch = {
      resolved: true,
      fileId: meta.id,
      resourceKey: meta.resourceKey || task.resourceKey || null,
      name: meta.name,
      mimeType: meta.mimeType,
      size: meta.size != null ? Number(meta.size) : null,
      md5: meta.md5Checksum || null,
      modifiedTime: meta.modifiedTime || null,
      driveId: meta.driveId || null,
      isFolder: meta.mimeType === FOLDER_MIME,
    };
    ctx.update(patch);
    return task;
  }

  // Decides the final local path once per task (so restarts keep writing to the same .part file).
  async function chooseTarget(task, fileName, ctx) {
    if (task.finalPath) return task.finalPath;
    await fs.promises.mkdir(task.destDir, { recursive: true });
    let target = path.join(task.destDir, fileName);
    if (await exists(target)) {
      const policy = settings.get('conflict');
      if (policy === 'skip') return null;
      if (policy === 'rename') target = await uniquePath(task.destDir, fileName);
    }
    ctx.update({ finalPath: target, partPath: target + PART_EXT, dest: target });
    return target;
  }

  async function finishFile(task, target) {
    if (settings.get('conflict') === 'rename' && (await exists(target))) {
      // Someone created the file while we were downloading: don't clobber it.
      target = await uniquePath(path.dirname(target), path.basename(target));
    }
    await fs.promises.rename(task.partPath, target);
    if (task.modifiedTime) {
      const t = new Date(task.modifiedTime);
      await fs.promises.utimes(target, t, t).catch(() => {});
    }
    return target;
  }

  // Streams `res` into the task's .part file starting at `start`, updating progress and an optional md5.
  async function streamToPart(task, res, start, total, ctx, hash) {
    const report = progressThrottle(ctx);
    let bytes = start;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (hash) hash.update(chunk);
        report(bytes, total);
        cb(null, chunk);
      },
    });
    const out = fs.createWriteStream(task.partPath, { flags: start > 0 ? 'a' : 'w' });
    try {
      await pipeline(Readable.fromWeb(res.body), counter, out, { signal: ctx.signal });
    } catch (e) {
      throw markRetryable(e, ctx.signal);
    }
    report(bytes, total ?? bytes, true);
    if (total != null && bytes < total) {
      throw new DriveError('Kết nối bị ngắt trước khi tải xong, sẽ tự tiếp tục.', { retryable: true });
    }
    return bytes;
  }

  async function download(task, ctx) {
    if (task.public) return downloadPublic(task, ctx);
    await resolveMeta(task, ctx);
    if (task.isFolder) return scanDriveFolder(task, ctx);

    const native = isGoogleNative(task.mimeType);
    let fileName = sanitizeName(task.name);
    let exportMime = null;
    if (native) {
      const target = exportTarget(task.mimeType, settings.get('exportFormat'));
      if (!target) return { status: 'skipped', note: 'Google không cho tải loại file này (Forms, Sites, Maps…)' };
      exportMime = target[0];
      if (!fileName.toLowerCase().endsWith(target[1])) fileName += target[1];
    }

    const target = await chooseTarget(task, fileName, ctx);
    if (!target) return { status: 'skipped', note: 'Đã có file trùng tên' };

    const connections = settings.get('connectionsPerFile') || 1;
    if (!native && connections > 1 && task.size >= SEGMENTED_MIN_SIZE && !task.noSegments) {
      // An old single-stream .part (from before this feature or a fallback) keeps its own resume path.
      const partial = !task.segments && (await fs.promises.stat(task.partPath).catch(() => null));
      if (!partial || partial.size === 0) {
        ctx.update({ note: `${connections} kết nối song song` });
        let ok;
        try {
          ok = await downloadSegmented(task, ctx, { drive, connections, markRetryable });
        } catch (e) {
          if (e.reason === 'cannotDownloadAbusiveFile' && !task.acknowledgeAbuse) {
            ctx.update({ acknowledgeAbuse: true });
            throw new DriveError('Google cảnh báo file này, đang tải lại với xác nhận.', { retryable: true });
          }
          throw e;
        }
        if (ok) {
          if (task.md5 && settings.get('verifyMd5')) {
            ctx.update({ note: 'Đang kiểm tra MD5…' });
            const hash = await md5File(task.partPath, ctx.signal);
            if (hash.digest('hex') !== task.md5) {
              await fs.promises.rm(task.partPath, { force: true });
              ctx.update({ transferred: 0, note: null });
              throw new DriveError('Sai mã kiểm tra MD5, đang tải lại.', { retryable: true });
            }
          }
          const finalPath = await finishFile(task, target);
          ctx.update({ finalPath, dest: finalPath, note: null });
          return { note: `Tải bằng ${connections} kết nối` };
        }
        // Server ignored Range: fall through to a single stream.
      }
    }

    // Resume from an existing .part file when the server supports ranges (not for exports).
    let start = 0;
    if (!native) {
      const st = await fs.promises.stat(task.partPath).catch(() => null);
      if (st && task.size != null && st.size <= task.size) start = st.size;
    }

    const size = native ? null : task.size;
    if (!native && size === 0) {
      await fs.promises.writeFile(task.partPath, '');
    } else if (!native && start === size && size != null) {
      // Already fully downloaded before a restart; just finalize.
    } else {
      let res;
      try {
        res = native
          ? await drive.exportMedia(task.fileId, exportMime, { resourceKey: task.resourceKey, signal: ctx.signal })
          : await drive.media(task.fileId, { resourceKey: task.resourceKey, start, signal: ctx.signal, acknowledgeAbuse: task.acknowledgeAbuse });
      } catch (e) {
        if (e.reason === 'cannotDownloadAbusiveFile' && !task.acknowledgeAbuse) {
          ctx.update({ acknowledgeAbuse: true });
          throw new DriveError('Google cảnh báo file này, đang tải lại với xác nhận.', { retryable: true });
        }
        throw markRetryable(e, ctx.signal);
      }
      if (start > 0 && res.status !== 206) start = 0;

      const verify = !native && task.md5 && settings.get('verifyMd5');
      const hash = verify ? (start > 0 ? await md5File(task.partPath, ctx.signal) : crypto.createHash('md5')) : null;
      await streamToPart(task, res, start, size, ctx, hash);

      if (hash && hash.digest('hex') !== task.md5) {
        await fs.promises.rm(task.partPath, { force: true });
        ctx.update({ transferred: 0 });
        throw new DriveError('Sai mã kiểm tra MD5, đang tải lại.', { retryable: true });
      }
    }

    const finalPath = await finishFile(task, target);
    ctx.update({ finalPath, dest: finalPath });
    return { note: native ? `Đã xuất sang ${path.extname(fileName).slice(1).toUpperCase()}` : null };
  }

  async function downloadPublic(task, ctx) {
    let start = 0;
    if (task.partPath) {
      const st = await fs.promises.stat(task.partPath).catch(() => null);
      if (st) start = st.size;
    }
    let res;
    try {
      res = await drive.publicMedia(task.fileId, { resourceKey: task.resourceKey, start, signal: ctx.signal });
    } catch (e) {
      throw markRetryable(e, ctx.signal);
    }
    if (start > 0 && res.status !== 206) start = 0;

    let total = task.size;
    if (res.status === 206) {
      const m = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
      if (m) total = Number(m[1]);
    } else if (res.headers.get('content-length')) {
      total = Number(res.headers.get('content-length'));
    }

    let target = task.finalPath;
    if (!target) {
      const name = sanitizeName(parseContentDisposition(res.headers.get('content-disposition')) || task.name || task.fileId);
      ctx.update({ name });
      target = await chooseTarget(task, name, ctx);
      if (!target) {
        await res.body?.cancel().catch(() => {});
        return { status: 'skipped', note: 'Đã có file trùng tên' };
      }
    }
    ctx.update({ size: total ?? null });
    await streamToPart(task, res, start, total ?? null, ctx, null);
    const finalPath = await finishFile(task, target);
    ctx.update({ finalPath, dest: finalPath });
    return {};
  }

  // ---------------------------------------------------------------- uploads

  async function uniqueDriveName(parentId, driveId, name) {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    let candidate = name;
    for (let i = 1; (await drive.findChild(parentId, candidate, driveId)).length; i++) {
      candidate = `${base} (${i})${ext}`;
    }
    return candidate;
  }

  async function scanLocalFolder(task, ctx) {
    let folderId = task.driveFolderId;
    if (!folderId) {
      const existing = (await drive.findChild(task.parentId, task.name, task.driveId)).filter((f) => f.mimeType === FOLDER_MIME);
      // Merge into an existing folder of the same name, like Explorer does.
      const folder = existing[0] || (await drive.createFolder(task.name, task.parentId));
      folderId = folder.id;
      ctx.update({ driveFolderId: folderId });
    }
    const entries = await fs.promises.readdir(task.localPath, { withFileTypes: true });
    let files = 0;
    let folders = 0;
    const specs = [];
    for (const e of entries) {
      if (!e.isFile() && !e.isDirectory()) continue;
      if (e.name.endsWith(PART_EXT)) continue;
      if (e.isDirectory()) folders++;
      else files++;
      specs.push(uploadSpec(path.join(task.localPath, e.name), e.isDirectory(), { id: folderId, driveId: task.driveId, label: `${task.dest}/${task.name}` }));
    }
    if (specs.length) ctx.enqueue(specs);
    return { note: `${files} file, ${folders} thư mục con` };
  }

  async function upload(task, ctx) {
    if (task.isFolder) return scanLocalFolder(task, ctx);

    const st = await fs.promises.stat(task.localPath);
    const size = st.size;
    const chunk = settings.get('uploadChunkMB') * 1024 * 1024;
    const report = progressThrottle(ctx);

    // A saved session is only valid for the exact same file contents.
    if (task.sessionUri && (task.sessionSize !== size || task.sessionMtime !== st.mtimeMs)) {
      ctx.update({ sessionUri: null });
    }

    let offset = 0;
    if (task.sessionUri) {
      try {
        const state = await drive.queryUpload(task.sessionUri, size);
        if (state.done) {
          report(size, size, true);
          ctx.update({ driveFileId: state.file.id });
          return {};
        }
        offset = state.offset;
      } catch (e) {
        if (e.status === 404 || e.status === 410) ctx.update({ sessionUri: null });
        else throw markRetryable(e, ctx.signal);
      }
    }

    if (!task.sessionUri) {
      let name = task.name;
      let existingId = null;
      const existing = (await drive.findChild(task.parentId, name, task.driveId)).filter((f) => f.mimeType !== FOLDER_MIME);
      if (existing.length) {
        const policy = settings.get('conflict');
        if (policy === 'skip') return { status: 'skipped', note: 'Đã có file trùng tên trên Drive' };
        if (policy === 'overwrite') existingId = existing[0].id;
        else name = await uniqueDriveName(task.parentId, task.driveId, name);
      }
      const sessionUri = await drive.startUpload({
        name,
        parentId: task.parentId,
        size,
        mimeType: mimeFor(name),
        modifiedTime: st.mtime.toISOString(),
        existingId,
      });
      ctx.update({ sessionUri, sessionSize: size, sessionMtime: st.mtimeMs, name, size });
      offset = 0;
    }

    ctx.update({ size });
    report(offset, size, true);

    if (size === 0) {
      const state = await drive.uploadChunk(task.sessionUri, { size: 0, start: 0, end: 0, signal: ctx.signal });
      ctx.update({ driveFileId: state.file?.id });
      return {};
    }

    while (offset < size) {
      const start = offset;
      const end = Math.min(size, start + chunk);
      let sent = start;
      const signal = ctx.signal;
      const iterable = (async function* () {
        for await (const buf of fs.createReadStream(task.localPath, { start, end: end - 1, highWaterMark: 256 * 1024 })) {
          if (signal.aborted) return;
          sent += buf.length;
          report(sent, size);
          yield buf;
        }
      })();

      let state;
      try {
        state = await drive.uploadChunk(task.sessionUri, { iterable, start, end, size, signal });
      } catch (e) {
        // The saved session lets the retry pick up from the last byte Google acknowledged.
        throw markRetryable(e, ctx.signal);
      }
      if (state.done) {
        report(size, size, true);
        ctx.update({ driveFileId: state.file.id });
        return {};
      }
      offset = state.offset;
      report(offset, size, true);
    }
    // All bytes sent but no final response: ask the session.
    const state = await drive.queryUpload(task.sessionUri, size);
    if (!state.done) throw new DriveError('Google chưa xác nhận file, sẽ thử lại.', { retryable: true });
    ctx.update({ driveFileId: state.file.id });
    return {};
  }

  async function onCancel(task) {
    if (task.type === 'download' && task.partPath) {
      await fs.promises.rm(task.partPath, { force: true });
    }
  }

  return { runners: { download, upload }, hooks: { onCancel } };
}

// Builds a queue spec for downloading a Drive item into destDir.
function downloadSpec(file, destDir, { resolved = true, sourcePrefix = '' } = {}) {
  const isFolder = file.mimeType === FOLDER_MIME;
  return {
    type: 'download',
    fileId: file.id,
    resourceKey: file.resourceKey || null,
    driveId: file.driveId || null,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size != null ? Number(file.size) : null,
    md5: file.md5Checksum || null,
    modifiedTime: file.modifiedTime || null,
    isFolder,
    resolved,
    destDir,
    source: sourcePrefix ? `${sourcePrefix}/${file.name}` : `Drive/${file.name}`,
    dest: destDir,
  };
}

// Builds a queue spec for uploading a local path into a Drive folder.
function uploadSpec(localPath, isFolder, parent) {
  const name = path.basename(localPath);
  let size = null;
  if (!isFolder) {
    try {
      size = fs.statSync(localPath).size;
    } catch {
      // resolved when the task runs
    }
  }
  return {
    type: 'upload',
    localPath,
    isFolder,
    name,
    size,
    parentId: parent.id,
    driveId: parent.driveId || null,
    source: localPath,
    dest: parent.label || 'Drive',
  };
}

module.exports = { createRunners, downloadSpec, uploadSpec, PART_EXT, mimeFor };
