'use strict';

const fs = require('fs');
const path = require('path');

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// Makes a Drive file name safe to use as a local file name on Windows, macOS and Linux.
function sanitizeName(name) {
  let s = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  s = s.replace(/[. ]+$/g, '').trim();
  if (!s) s = 'untitled';
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  // Keep file names well under common 255-byte limits.
  if (Buffer.byteLength(s) > 200) {
    const ext = path.extname(s).slice(0, 20);
    let base = s.slice(0, s.length - ext.length);
    while (Buffer.byteLength(base + ext) > 200) base = base.slice(0, -1);
    s = base + ext;
  }
  return s;
}

async function exists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

// "photo.jpg" -> "photo (1).jpg", "photo (2).jpg", ... first free name in dir.
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; await exists(candidate); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

module.exports = { sanitizeName, exists, uniquePath };
