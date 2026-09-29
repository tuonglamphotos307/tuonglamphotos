'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) {
    const err = new Error(res.error);
    err.code = res.code;
    throw err;
  }
  return res.data;
}

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  info: () => call('app:info'),
  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
    importCredentials: () => call('settings:importCredentials'),
  },
  auth: {
    status: () => call('auth:status'),
    login: () => call('auth:login'),
    logout: () => call('auth:logout'),
    onChange: on('auth:changed'),
  },
  drive: {
    about: () => call('drive:about'),
    list: (where) => call('drive:list', where),
    get: (id, rk) => call('drive:get', id, rk),
    mkdir: (parentId, name) => call('drive:mkdir', parentId, name),
    rename: (id, name) => call('drive:rename', id, name),
    trash: (ids) => call('drive:trash', ids),
  },
  links: {
    resolve: (text) => call('links:resolve', text),
  },
  transfer: {
    download: (items, destDir) => call('transfer:download', { items, destDir }),
    upload: (paths, parent) => call('transfer:upload', { paths, parent }),
  },
  sync: {
    plan: (args) => call('sync:plan', args),
    run: (args) => call('sync:run', args),
  },
  queue: {
    snapshot: () => call('queue:snapshot'),
    action: (action, ids) => call('queue:action', { action, ids }),
    onUpdate: on('queue:update'),
  },
  local: {
    roots: () => call('local:roots'),
    list: (dir) => call('local:list', dir),
    freeSpace: (dir) => call('local:freeSpace', dir),
    mkdir: (parent, name) => call('local:mkdir', parent, name),
    rename: (p, name) => call('local:rename', p, name),
    trash: (paths) => call('local:trash', paths),
    open: (p) => call('local:open', p),
    reveal: (p) => call('local:reveal', p),
    exists: (p) => call('local:exists', p),
  },
  setTheme: (theme) => call('window:theme', theme),
  platform: process.platform,
  pickFolder: (defaultPath) => call('dialog:pickFolder', defaultPath),
  openExternal: (url) => call('shell:openExternal', url),
  // Files dropped from Explorer/Finder: File.path no longer exists in modern Electron.
  pathForFile: (file) => webUtils.getPathForFile(file),
});
