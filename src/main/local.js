'use strict';

// Local file system browsing for the left pane.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HIDDEN_WIN = new Set(['$recycle.bin', 'system volume information', 'desktop.ini', 'thumbs.db', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log.tmp']);

async function roots() {
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
    const found = await Promise.all(
      letters.map(async (l) => {
        const p = `${l}:\\`;
        try {
          await fs.promises.access(p);
          return p;
        } catch {
          return null;
        }
      }),
    );
    return found.filter(Boolean).map((p) => ({ name: p.slice(0, 2), path: p }));
  }
  const out = [{ name: '/', path: '/' }];
  for (const base of ['/Volumes', '/media', `/media/${os.userInfo().username}`, '/mnt']) {
    try {
      for (const e of await fs.promises.readdir(base, { withFileTypes: true })) {
        if (e.isDirectory()) out.push({ name: e.name, path: path.join(base, e.name) });
      }
    } catch {
      // not present on this OS
    }
  }
  return out;
}

async function list(dir, { showHidden = false } = {}) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (e) => {
      const name = e.name;
      if (!showHidden && (name.startsWith('.') || (process.platform === 'win32' && HIDDEN_WIN.has(name.toLowerCase())))) return null;
      if (name.endsWith('.drivedock-part')) return null;
      const full = path.join(dir, name);
      try {
        const st = await fs.promises.stat(full);
        return { name, path: full, isDir: st.isDirectory(), size: st.isDirectory() ? null : st.size, mtime: st.mtimeMs };
      } catch {
        // Broken link or no permission: still show it so the user sees it exists.
        return { name, path: full, isDir: e.isDirectory(), size: null, mtime: null, unreadable: true };
      }
    }),
  );
  return items.filter(Boolean);
}

async function freeSpace(dir) {
  try {
    const st = await fs.promises.statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

async function mkdir(parent, name) {
  const p = path.join(parent, name);
  await fs.promises.mkdir(p);
  return p;
}

async function rename(p, name) {
  const target = path.join(path.dirname(p), name);
  await fs.promises.rename(p, target);
  return target;
}

module.exports = { roots, list, freeSpace, mkdir, rename };
