'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  clientId: '',
  clientSecret: '',
  apiKey: '',
  concurrency: 3,
  connectionsPerFile: 4,
  downloadLimitKBps: 0, // 0 = unlimited
  uploadLimitKBps: 0,
  closeToTray: false, // closing the window keeps DriveDock running in the tray (schedules keep working)
  startWithSystem: false, // launch hidden when the user signs in
  windowEnabled: false, // only transfer between windowStart and windowEnd
  windowStart: '23:00',
  windowEnd: '06:00',
  uploadChunkMB: 16,
  conflict: 'rename', // rename | overwrite | skip
  exportFormat: 'office', // office | pdf | open
  verifyMd5: true,
  autoResume: false,
  defaultDownloadDir: '',
  maxRetries: 6,
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // first run or unreadable file: keep defaults
    }
  }

  get(key) {
    return key ? this.data[key] : { ...this.data };
  }

  set(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in DEFAULTS) this.data[k] = v;
    }
    this.data.connectionsPerFile = Math.min(8, Math.max(1, Math.round(Number(this.data.connectionsPerFile) || DEFAULTS.connectionsPerFile)));
    for (const k of ['windowStart', 'windowEnd']) if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(this.data[k])) this.data[k] = DEFAULTS[k];
    for (const k of ['downloadLimitKBps', 'uploadLimitKBps']) this.data[k] = Math.max(0, Math.round(Number(this.data[k]) || 0));
    this.data.concurrency = Math.min(8, Math.max(1, Number(this.data.concurrency) || DEFAULTS.concurrency));
    // Resumable upload chunks must be multiples of 256 KiB; whole MB always are.
    this.data.uploadChunkMB = Math.min(256, Math.max(1, Math.round(Number(this.data.uploadChunkMB) || DEFAULTS.uploadChunkMB)));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return this.get();
  }
}

module.exports = { Settings, DEFAULTS };
