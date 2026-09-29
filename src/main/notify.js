'use strict';

// Pure helpers for "batch finished" notifications (no Electron here, so they are unit-testable).

const NF = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${NF.format(v)} ${units[i]}`;
}

// Counts what happened since `since` (epoch ms) among real files (folders are just scan steps).
function summarizeBatch(tasks, since) {
  const sum = { down: 0, up: 0, skipped: 0, errors: 0, bytes: 0, firstError: null };
  for (const t of tasks) {
    if (t.isFolder) continue;
    if (t.status === 'done' && (t.finishedAt || 0) >= since) {
      if (t.type === 'upload') sum.up++;
      else sum.down++;
      sum.bytes += t.size || 0;
    } else if (t.status === 'skipped' && (t.finishedAt || 0) >= since) {
      sum.skipped++;
    } else if (t.status === 'error') {
      sum.errors++;
      sum.firstError = sum.firstError || t.error;
    }
  }
  return sum;
}

// Returns { title, body } or null when there is nothing worth telling the user.
function formatBatch(sum) {
  const files = sum.down + sum.up;
  if (!files && !sum.errors) return null;
  const parts = [];
  if (sum.down) parts.push(`${sum.down} file đã tải về`);
  if (sum.up) parts.push(`${sum.up} file đã tải lên`);
  if (files) parts.push(fmtBytes(sum.bytes));
  let body = parts.join(' · ');
  if (sum.errors) body += `${body ? '\n' : ''}${sum.errors} file lỗi${sum.firstError ? `: ${sum.firstError}` : ''}`;
  return { title: sum.errors ? 'DriveDock: xong, có file lỗi' : 'DriveDock: đã xong', body };
}

module.exports = { summarizeBatch, formatBatch, fmtBytes };
