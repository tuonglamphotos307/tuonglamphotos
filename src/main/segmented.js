'use strict';

// Multi-connection download of one large file (like a download accelerator).
//
// The file is split into byte ranges, each fetched on its own connection and written in place into a
// pre-sized .part file. When a connection finishes early it "steals" the second half of the biggest
// range still in flight, so every connection stays busy until the end. Segment positions live on the
// task (task.segments) and are persisted by the queue, so a restart resumes every range where it stopped.

const fs = require('fs');
const { DriveError } = require('./drive');

const MIN_SPLIT = 4 * 1024 * 1024; // never split a range into pieces smaller than this
const PERSIST_MS = 1000;
const PROGRESS_MS = 200;

class RangeUnsupported extends Error {}

function planSegments(size, n) {
  const count = Math.max(1, Math.min(n, Math.floor(size / MIN_SPLIT) || 1));
  const step = Math.ceil(size / count);
  const segs = [];
  for (let start = 0; start < size; start += step) {
    segs.push({ start, pos: start, end: Math.min(size, start + step) });
  }
  return segs;
}

const remaining = (segs) => segs.reduce((sum, s) => sum + Math.max(0, s.end - s.pos), 0);

// Resolves true when the whole file is in task.partPath, false if the server ignores Range requests
// (the caller then falls back to a single stream). Throws on errors, leaving task.segments resumable.
async function downloadSegmented(task, ctx, { drive, connections, markRetryable, throttle }) {
  const size = task.size;
  let segs = task.segments;
  const st = await fs.promises.stat(task.partPath).catch(() => null);
  const resumable = Array.isArray(segs) && task.segmentsSize === size && st && st.size === size;

  let fh;
  if (resumable) {
    fh = await fs.promises.open(task.partPath, 'r+');
  } else {
    segs = planSegments(size, connections);
    fh = await fs.promises.open(task.partPath, 'w');
    await fh.truncate(size); // sparse on NTFS/ext4/APFS: no upfront write of the whole file
  }
  ctx.update({ segments: segs, segmentsSize: size });

  const stop = new AbortController();
  const onOuterAbort = () => stop.abort(ctx.signal.reason);
  ctx.signal.addEventListener('abort', onOuterAbort, { once: true });

  let lastProgress = 0;
  let lastPersist = Date.now();
  const tick = (force) => {
    const now = Date.now();
    if (force || now - lastProgress >= PROGRESS_MS) {
      lastProgress = now;
      ctx.progress(size - remaining(segs), size);
    }
    if (force || now - lastPersist >= PERSIST_MS) {
      lastPersist = now;
      ctx.update({ segments: segs }); // same array, mutated in place: this just marks the task dirty
    }
  };

  const active = new Set();
  let failure = null;

  // An idle range if there is one, otherwise split the largest range still downloading.
  const nextSegment = () => {
    const idle = segs.find((s) => s.pos < s.end && !active.has(s));
    if (idle) return idle;
    let best = null;
    for (const s of active) {
      const rem = s.end - s.pos;
      if (rem >= 2 * MIN_SPLIT && (!best || rem > best.end - best.pos)) best = s;
    }
    if (!best) return null;
    const mid = best.pos + Math.floor((best.end - best.pos) / 2);
    const piece = { start: mid, pos: mid, end: best.end };
    best.end = mid; // the worker on `best` sees the new end on its next chunk
    segs.push(piece);
    return piece;
  };

  async function fetchSegment(seg) {
    const conn = new AbortController();
    const abortConn = () => conn.abort(stop.signal.reason);
    stop.signal.addEventListener('abort', abortConn, { once: true });
    const before = seg.pos;
    try {
      const res = await drive.media(task.fileId, {
        resourceKey: task.resourceKey,
        start: seg.pos,
        end: seg.end - 1,
        signal: conn.signal,
        acknowledgeAbuse: task.acknowledgeAbuse,
      });
      if (res.status !== 206) {
        await res.body?.cancel().catch(() => {});
        throw new RangeUnsupported('range not supported');
      }
      const reader = res.body.getReader();
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (seg.pos >= seg.end && !stop.signal.aborted) break; // we cut it off after a steal
          throw e;
        }
        if (chunk.done) break;
        let buf = chunk.value;
        const room = seg.end - seg.pos;
        if (buf.length > room) buf = buf.subarray(0, room);
        if (buf.length) {
          if (throttle) await throttle.take(buf.length, conn.signal);
          await fh.write(buf, 0, buf.length, seg.pos);
          seg.pos += buf.length;
          tick(false);
        }
        if (seg.pos >= seg.end) {
          conn.abort(new Error('segment complete'));
          break;
        }
      }
      if (seg.pos < seg.end && seg.pos === before) {
        throw new DriveError('Máy chủ đóng kết nối mà không gửi dữ liệu.', { retryable: true });
      }
      // Ended early with some progress: the range stays idle and a worker picks it up again.
    } finally {
      stop.signal.removeEventListener('abort', abortConn);
    }
  }

  async function worker() {
    while (!failure && !stop.signal.aborted) {
      const seg = nextSegment();
      if (!seg) return;
      active.add(seg);
      try {
        await fetchSegment(seg);
      } catch (e) {
        if (!failure) failure = e;
        stop.abort(e);
      } finally {
        active.delete(seg);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, connections) }, worker));
  } finally {
    ctx.signal.removeEventListener('abort', onOuterAbort);
    await fh.close().catch(() => {});
    tick(true);
  }

  if (failure instanceof RangeUnsupported) {
    await fs.promises.rm(task.partPath, { force: true });
    ctx.update({ segments: null, segmentsSize: null, noSegments: true, transferred: 0 });
    return false;
  }
  if (failure) throw ctx.signal.aborted ? failure : markRetryable(failure, ctx.signal);
  if (ctx.signal.aborted) throw ctx.signal.reason || new Error('aborted');
  if (remaining(segs) > 0) throw new DriveError('Tải chưa đủ dữ liệu, sẽ tự tiếp tục.', { retryable: true });
  ctx.update({ segments: null, segmentsSize: null });
  return true;
}

module.exports = { downloadSegmented, planSegments, MIN_SPLIT };
