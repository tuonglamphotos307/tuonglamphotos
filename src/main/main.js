'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const { Settings } = require('./settings');
const { Auth } = require('./auth');
const { DriveClient, FOLDER_MIME } = require('./drive');
const { TransferQueue } = require('./queue');
const { createRunners, downloadSpec, uploadSpec } = require('./transfers');
const { parseManyLinks } = require('./links');
const local = require('./local');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

nativeTheme.themeSource = 'system';

// Window chrome colors per theme; the page draws everything else.
const CHROME = {
  light: { color: '#efebe3', symbolColor: '#18171b' },
  dark: { color: '#111115', symbolColor: '#f2efe8' },
};
const TITLEBAR_H = 40;

let win = null;
let settings;
let auth;
let drive;
let queue;
let quitting = false;

const dataDir = () => app.getPath('userData');

function createWindow() {
  const stateFile = path.join(dataDir(), 'window.json');
  let bounds = { width: 1400, height: 880 };
  try {
    bounds = { ...bounds, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
  } catch {
    // first launch
  }

  const chrome = CHROME[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
  win = new BrowserWindow({
    ...bounds,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: chrome.color,
    autoHideMenuBar: true,
    title: 'DriveDock',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    // Frameless look: the OS keeps drawing min/max/close as an overlay in the top-right corner.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 14 } }
      : { titleBarOverlay: { ...chrome, height: TITLEBAR_H } }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (bounds.maximized) win.maximize();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open target=_blank / external links in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }));
    if (!quitting && queue.hasActive()) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Thoát', 'Ở lại'],
        defaultId: 1,
        cancelId: 1,
        title: 'Đang truyền file',
        message: 'Vẫn còn file đang tải. Thoát bây giờ?',
        detail: 'Các file dở dang sẽ được giữ lại và tiếp tục ở lần mở sau.',
      });
      if (choice === 1) {
        e.preventDefault();
        return;
      }
    }
    quitting = true;
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Every IPC handler returns { ok, data } / { ok: false, error, code } so the renderer gets clean messages.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[${channel}]`, err);
      return { ok: false, error: err.message || String(err), code: err.code || err.reason || null };
    }
  });
}

function tokenBox() {
  const encrypted = safeStorage.isEncryptionAvailable();
  return {
    encrypt: (s) => (encrypted ? safeStorage.encryptString(s) : Buffer.from(s, 'utf8')),
    decrypt: (b) => (encrypted ? safeStorage.decryptString(b) : b.toString('utf8')),
  };
}

function registerIpc() {
  handle('app:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    paths: {
      home: app.getPath('home'),
      desktop: app.getPath('desktop'),
      documents: app.getPath('documents'),
      downloads: app.getPath('downloads'),
      pictures: app.getPath('pictures'),
    },
  }));

  handle('window:theme', (theme) => {
    const c = CHROME[theme === 'dark' ? 'dark' : 'light'];
    nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light';
    if (!win) return;
    win.setBackgroundColor(c.color);
    if (process.platform !== 'darwin') win.setTitleBarOverlay({ ...c, height: TITLEBAR_H });
  });

  handle('settings:get', () => settings.get());
  handle('settings:set', (patch) => {
    const out = settings.set(patch);
    queue._schedule();
    send('auth:changed', auth.status());
    return out;
  });
  handle('settings:importCredentials', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Chọn file credentials.json (OAuth client – Desktop app)',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const json = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const c = json.installed || json.web || json;
    if (!c.client_id) throw new Error('File không chứa client_id. Hãy tải file JSON của OAuth client loại "Desktop app".');
    return settings.set({ clientId: c.client_id, clientSecret: c.client_secret || '' });
  });

  handle('auth:status', () => auth.status());
  handle('auth:login', async () => {
    const s = await auth.login();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    send('auth:changed', s);
    return s;
  });
  handle('auth:logout', async () => {
    const s = await auth.logout();
    send('auth:changed', s);
    return s;
  });

  handle('drive:about', () => drive.about());
  handle('drive:list', (where) => drive.list(where));
  handle('drive:get', (id, resourceKey) => drive.get(id, resourceKey));
  handle('drive:mkdir', (parentId, name) => drive.createFolder(name, parentId));
  handle('drive:rename', (id, name) => drive.rename(id, name));
  handle('drive:trash', async (ids) => {
    for (const id of ids) await drive.trash(id);
  });

  // Resolves pasted links into downloadable items (metadata only, nothing is downloaded yet).
  handle('links:resolve', async (text) => {
    const links = parseManyLinks(text);
    return Promise.all(
      links.map(async (link) => {
        try {
          if (drive.canUseApi) {
            let meta;
            try {
              meta = await drive.get(link.id, link.resourceKey);
            } catch (err) {
              // Some public links are not visible to the API (e.g. missing resource key): try the public endpoint.
              if (err.status !== 404 || link.kind === 'folder') throw err;
              const probe = await drive.publicProbe(link.id, link.resourceKey).catch(() => null);
              if (!probe) throw err;
              return { input: link.input, ok: true, item: probe };
            }
            meta = await drive.resolveShortcut(meta);
            if (!meta.resourceKey && link.resourceKey) meta.resourceKey = link.resourceKey;
            return { input: link.input, ok: true, item: { ...meta, isFolder: meta.mimeType === FOLDER_MIME } };
          }
          if (link.kind === 'folder') {
            throw Object.assign(new Error('Tải cả thư mục cần kết nối Google Drive (hoặc nhập API key trong Cài đặt).'), { code: 'NEED_LOGIN' });
          }
          if (['document', 'spreadsheet', 'presentation', 'drawing'].includes(link.kind)) {
            throw Object.assign(new Error('Tải file Google Docs/Sheets/Slides cần kết nối Google Drive.'), { code: 'NEED_LOGIN' });
          }
          const probe = await drive.publicProbe(link.id, link.resourceKey);
          return { input: link.input, ok: true, item: probe };
        } catch (err) {
          return { input: link.input, ok: false, error: err.message, code: err.code || null, id: link.id };
        }
      }),
    );
  });

  handle('transfer:download', ({ items, destDir }) => {
    const specs = items.map((it) => {
      if (it.public) {
        return { type: 'download', public: true, fileId: it.id, resourceKey: it.resourceKey || null, name: it.name, size: it.size, destDir, source: `Link công khai/${it.name}`, dest: destDir };
      }
      return downloadSpec(it, destDir, { resolved: !(it.mimeType === 'application/vnd.google-apps.shortcut') });
    });
    return queue.add(specs).length;
  });

  handle('transfer:upload', ({ paths, parent }) => {
    const specs = paths.map((p) => uploadSpec(p, fs.statSync(p).isDirectory(), parent));
    return queue.add(specs).length;
  });

  handle('queue:snapshot', () => queue.snapshot());
  handle('queue:action', ({ action, ids }) => {
    const target = ids || 'all';
    switch (action) {
      case 'pause': return queue.pause(target);
      case 'resume': return queue.resume(target);
      case 'retry': return queue.retry(target);
      case 'cancel': return queue.cancel(target);
      case 'remove': return queue.remove(target);
      case 'clearFinished': return queue.clearFinished();
      default: throw new Error(`Unknown action ${action}`);
    }
  });

  handle('local:roots', () => local.roots());
  handle('local:list', (dir) => local.list(dir));
  handle('local:freeSpace', (dir) => local.freeSpace(dir));
  handle('local:mkdir', (parent, name) => local.mkdir(parent, name));
  handle('local:rename', (p, name) => local.rename(p, name));
  handle('local:trash', async (paths) => {
    for (const p of paths) await shell.trashItem(p);
  });
  handle('local:open', async (p) => {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });
  handle('local:reveal', (p) => shell.showItemInFolder(p));
  handle('local:exists', (p) => fs.existsSync(p));

  handle('dialog:pickFolder', async (defaultPath) => {
    const r = await dialog.showOpenDialog(win, { title: 'Chọn thư mục lưu', defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('shell:openExternal', (url) => {
    if (!/^https:\/\//.test(url)) throw new Error('Chỉ mở được link https');
    return shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  settings = new Settings(dataDir());
  auth = new Auth({ dir: dataDir(), settings, openExternal: (u) => shell.openExternal(u), crypto: tokenBox() });
  drive = new DriveClient({ auth, settings });
  const { runners, hooks } = createRunners({ drive, settings });
  queue = new TransferQueue({
    file: path.join(dataDir(), 'queue.json'),
    runners,
    hooks,
    getConcurrency: () => settings.get('concurrency'),
    getMaxRetries: () => settings.get('maxRetries'),
    getAutoResume: () => settings.get('autoResume'),
  });
  queue.on('update', (u) => send('queue:update', u));

  registerIpc();
  createWindow();
  queue._schedule();

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
});

app.on('before-quit', () => {
  quitting = true;
  queue?.shutdown();
});

app.on('window-all-closed', () => app.quit());
