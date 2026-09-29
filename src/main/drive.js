'use strict';

// Minimal Google Drive v3 REST client built on fetch, with retries and streaming.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const PUBLIC_DL = 'https://drive.usercontent.google.com/download';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,md5Checksum,resourceKey,driveId,parents,webViewLink,' +
  'shortcutDetails(targetId,targetMimeType,targetResourceKey),capabilities(canDownload,canAddChildren,canRename,canTrash)';

// Export targets for Google-native files. [mimeType, extension]
const EXPORTS = {
  office: {
    'application/vnd.google-apps.document': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
    'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
    'application/vnd.google-apps.presentation': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
    'application/vnd.google-apps.drawing': ['image/png', '.png'],
  },
  open: {
    'application/vnd.google-apps.document': ['application/vnd.oasis.opendocument.text', '.odt'],
    'application/vnd.google-apps.spreadsheet': ['application/x-vnd.oasis.opendocument.spreadsheet', '.ods'],
    'application/vnd.google-apps.presentation': ['application/vnd.oasis.opendocument.presentation', '.odp'],
    'application/vnd.google-apps.drawing': ['image/svg+xml', '.svg'],
  },
  pdf: {
    'application/vnd.google-apps.document': ['application/pdf', '.pdf'],
    'application/vnd.google-apps.spreadsheet': ['application/pdf', '.pdf'],
    'application/vnd.google-apps.presentation': ['application/pdf', '.pdf'],
    'application/vnd.google-apps.drawing': ['application/pdf', '.pdf'],
  },
};
const SCRIPT_EXPORT = ['application/vnd.google-apps.script+json', '.json'];

const RETRYABLE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError', 'internalError']);

class DriveError extends Error {
  constructor(message, { status = 0, reason = '', retryable = false } = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.retryable = retryable;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason || new Error('aborted'));
    }, { once: true });
  });

const backoff = (attempt) => Math.min(32_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 1000);

function isGoogleNative(mimeType) {
  return typeof mimeType === 'string' && mimeType.startsWith('application/vnd.google-apps.') && mimeType !== FOLDER_MIME && mimeType !== SHORTCUT_MIME;
}

// Returns [exportMime, ext] for a Google-native file, or null if it cannot be downloaded (Forms, Sites, Maps...).
function exportTarget(mimeType, format = 'office') {
  if (mimeType === 'application/vnd.google-apps.script') return SCRIPT_EXPORT;
  return (EXPORTS[format] || EXPORTS.office)[mimeType] || null;
}

function parseContentDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to plain filename
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
  if (plain) return (plain[1] ?? plain[2]).trim();
  return null;
}

async function errorFromResponse(res) {
  let reason = '';
  let message = `HTTP ${res.status}`;
  try {
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      const e = data.error || {};
      reason = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
      message = e.message || message;
    } catch {
      if (text && text.length < 300) message = text;
    }
  } catch {
    // ignore body read errors
  }
  const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && RETRYABLE_REASONS.has(reason));
  return new DriveError(friendlyMessage(res.status, reason, message), { status: res.status, reason, retryable });
}

function friendlyMessage(status, reason, fallback) {
  if (status === 404) return 'Không tìm thấy file hoặc anh không có quyền truy cập.';
  if (reason === 'downloadQuotaExceeded') return 'File đã vượt giới hạn lượt tải của Google. Thử lại sau 24 giờ.';
  if (reason === 'cannotDownloadAbusiveFile') return 'Google đánh dấu file có thể chứa mã độc.';
  if (reason === 'storageQuotaExceeded') return 'Drive đã hết dung lượng lưu trữ.';
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || status === 429) return 'Google đang giới hạn tốc độ, sẽ thử lại.';
  if (reason === 'exportSizeLimitExceeded') return 'File Google Docs quá lớn để xuất.';
  if (reason === 'insufficientFilePermissions' || reason === 'forbidden') return 'Anh không có quyền với file này.';
  return fallback;
}

function withQuery(url, query) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

class DriveClient {
  constructor({ auth, settings }) {
    this.auth = auth;
    this.settings = settings;
  }

  get canUseApi() {
    return this.auth.isLoggedIn() || Boolean((this.settings.get('apiKey') || '').trim());
  }

  // Low-level request. Handles auth (OAuth or API key), 401 refresh and retry of transient errors.
  // Returns the Response when res.ok (or when opts.accept(res) is true); throws DriveError otherwise.
  async request(url, opts = {}) {
    const { method = 'GET', query, headers = {}, body, signal, resourceKeys, retries, accept, duplex } = opts;
    const maxRetries = retries ?? this.settings.get('maxRetries') ?? 6;
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const h = { ...headers };
      const q = { ...query };
      if (this.auth.isLoggedIn()) {
        h.Authorization = `Bearer ${await this.auth.getAccessToken()}`;
      } else if ((this.settings.get('apiKey') || '').trim()) {
        q.key = this.settings.get('apiKey').trim();
      }
      if (resourceKeys && resourceKeys.length) h['X-Goog-Drive-Resource-Keys'] = resourceKeys.join(',');

      let res;
      try {
        res = await fetch(withQuery(url.startsWith('http') ? url : API + url, q), {
          method,
          headers: h,
          body: typeof body === 'function' ? body() : body,
          signal,
          ...(duplex ? { duplex } : {}),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        if (attempt < maxRetries && typeof body !== 'object') {
          await sleep(backoff(attempt), signal);
          continue;
        }
        throw new DriveError(`Lỗi mạng: ${e.cause?.code || e.message}`, { retryable: true });
      }

      if (res.ok || (accept && accept(res))) return res;

      if (res.status === 401 && this.auth.isLoggedIn() && !refreshed) {
        refreshed = true;
        await res.body?.cancel().catch(() => {});
        await this.auth.getAccessToken(true);
        attempt--;
        continue;
      }
      const err = await errorFromResponse(res);
      if (err.retryable && attempt < maxRetries && typeof body !== 'object') {
        await sleep(backoff(attempt), signal);
        continue;
      }
      throw err;
    }
  }

  async json(path, opts) {
    const res = await this.request(path, opts);
    return res.json();
  }

  about() {
    return this.json('/about', { query: { fields: 'user,storageQuota' } });
  }

  get(id, resourceKey) {
    return this.json(`/files/${encodeURIComponent(id)}`, {
      query: { fields: FILE_FIELDS, supportsAllDrives: true },
      resourceKeys: resourceKey ? [`${id}/${resourceKey}`] : null,
    });
  }

  // Lists a folder. where: { id, driveId?, resourceKey? } or special ids 'root' | 'shared' | 'drives'.
  async list(where, { signal } = {}) {
    if (where.id === 'drives') {
      const drives = [];
      let pageToken;
      do {
        const data = await this.json('/drives', { query: { pageSize: 100, pageToken, fields: 'nextPageToken,drives(id,name)' }, signal });
        for (const d of data.drives || []) {
          drives.push({ id: d.id, name: d.name, mimeType: FOLDER_MIME, driveId: d.id, isSharedDrive: true });
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
      return drives;
    }

    const query = {
      pageSize: 1000,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      orderBy: 'folder,name_natural',
    };
    if (where.id === 'shared') {
      query.q = 'sharedWithMe = true and trashed = false';
    } else {
      query.q = `'${where.id.replace(/'/g, "\\'")}' in parents and trashed = false`;
      if (where.driveId) {
        query.corpora = 'drive';
        query.driveId = where.driveId;
      }
    }
    const resourceKeys = where.resourceKey ? [`${where.id}/${where.resourceKey}`] : null;
    const files = [];
    do {
      const data = await this.json('/files', { query, resourceKeys, signal });
      files.push(...(data.files || []));
      query.pageToken = data.nextPageToken;
    } while (query.pageToken);
    return files;
  }

  // Follows a shortcut to its target metadata. Returns the file itself if it is not a shortcut.
  async resolveShortcut(file) {
    if (file.mimeType !== SHORTCUT_MIME || !file.shortcutDetails) return file;
    const t = file.shortcutDetails;
    const target = await this.get(t.targetId, t.targetResourceKey);
    return { ...target, name: file.name || target.name };
  }

  async findChild(parentId, name, driveId) {
    const q = `'${parentId.replace(/'/g, "\\'")}' in parents and name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`;
    const query = { q, fields: `files(${FILE_FIELDS})`, supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: 10 };
    if (driveId) {
      query.corpora = 'drive';
      query.driveId = driveId;
    }
    const data = await this.json('/files', { query });
    return data.files || [];
  }

  createFolder(name, parentId) {
    return this.json('/files', {
      method: 'POST',
      query: { fields: FILE_FIELDS, supportsAllDrives: true },
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
  }

  rename(id, name) {
    return this.json(`/files/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      query: { fields: FILE_FIELDS, supportsAllDrives: true },
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name }),
    });
  }

  trash(id) {
    return this.json(`/files/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      query: { fields: 'id', supportsAllDrives: true },
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ trashed: true }),
    });
  }

  // Streams file content from byte `start` to `end` (inclusive, optional). Resolves to the Response (200 or 206).
  media(id, { resourceKey, start = 0, end = null, signal, acknowledgeAbuse } = {}) {
    const ranged = start > 0 || end != null;
    return this.request(`/files/${encodeURIComponent(id)}`, {
      query: { alt: 'media', supportsAllDrives: true, acknowledgeAbuse: acknowledgeAbuse ? 'true' : undefined },
      headers: ranged ? { Range: `bytes=${start}-${end ?? ''}` } : {},
      resourceKeys: resourceKey ? [`${id}/${resourceKey}`] : null,
      signal,
    });
  }

  // Exports a Google-native file. Uses exportLinks for large files that exceed the /export size limit.
  async exportMedia(id, mimeType, { resourceKey, signal } = {}) {
    const resourceKeys = resourceKey ? [`${id}/${resourceKey}`] : null;
    try {
      return await this.request(`/files/${encodeURIComponent(id)}/export`, { query: { mimeType }, resourceKeys, signal });
    } catch (e) {
      if (e.reason !== 'exportSizeLimitExceeded') throw e;
      const meta = await this.json(`/files/${encodeURIComponent(id)}`, { query: { fields: 'exportLinks', supportsAllDrives: true }, resourceKeys });
      const link = meta.exportLinks && meta.exportLinks[mimeType];
      if (!link) throw e;
      return this.request(link, { resourceKeys, signal });
    }
  }

  // Downloads a publicly shared file without login ("Anyone with the link").
  // Handles Google's "can't scan for viruses" interstitial for large files.
  async publicMedia(id, { resourceKey, start = 0, signal } = {}) {
    const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
    let url = withQuery(PUBLIC_DL, { id, export: 'download', confirm: 't', resourcekey: resourceKey });
    for (let hop = 0; hop < 3; hop++) {
      const res = await fetch(url, { headers, signal, redirect: 'follow' });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new DriveError(res.status === 404 ? 'File không tồn tại hoặc không được chia sẻ công khai.' : `HTTP ${res.status}`, {
          status: res.status,
          retryable: res.status === 429 || res.status >= 500,
        });
      }
      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/html')) return res;

      const html = await res.text();
      const form = /<form[^>]+id="download-form"[^>]+action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
      if (!form) {
        if (/quota|too many users/i.test(html)) {
          throw new DriveError('File đã vượt giới hạn lượt tải của Google. Đăng nhập rồi thử lại, hoặc thử sau 24 giờ.', { reason: 'downloadQuotaExceeded' });
        }
        throw new DriveError('File không được chia sẻ công khai. Hãy kết nối Google Drive để tải.', { status: 403 });
      }
      const params = {};
      for (const m of form[2].matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi)) params[m[1]] = m[2];
      url = withQuery(form[1].replace(/&amp;/g, '&'), params);
    }
    throw new DriveError('Không thể tải file công khai này.');
  }

  // Reads name/size of a public file by starting the download and aborting after the headers.
  async publicProbe(id, resourceKey) {
    const ctrl = new AbortController();
    const res = await this.publicMedia(id, { resourceKey, signal: ctrl.signal });
    const name = parseContentDisposition(res.headers.get('content-disposition')) || id;
    const size = Number(res.headers.get('content-length')) || null;
    ctrl.abort();
    return { id, name, size, mimeType: res.headers.get('content-type') || 'application/octet-stream', resourceKey, public: true };
  }

  // Starts a resumable upload session and returns its URI. existingId -> upload a new revision of that file.
  async startUpload({ name, parentId, size, mimeType, modifiedTime, existingId }) {
    const meta = existingId ? { modifiedTime } : { name, parents: [parentId], modifiedTime };
    const res = await this.request(existingId ? `${UPLOAD_API}/files/${encodeURIComponent(existingId)}` : `${UPLOAD_API}/files`, {
      method: existingId ? 'PATCH' : 'POST',
      query: { uploadType: 'resumable', supportsAllDrives: true },
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
      },
      body: JSON.stringify(meta),
    });
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!location) throw new DriveError('Google không trả về phiên tải lên.', { retryable: true });
    return location;
  }

  // Interprets a response from the upload session: { done, file } or { offset }.
  static async uploadState(res) {
    if (res.status === 200 || res.status === 201) return { done: true, file: await res.json() };
    const range = res.headers.get('range');
    await res.body?.cancel().catch(() => {});
    const m = range && /bytes=\d+-(\d+)/.exec(range);
    return { done: false, offset: m ? Number(m[1]) + 1 : 0 };
  }

  // Asks the session how many bytes it already has. Throws a 404/410 DriveError if the session expired.
  async queryUpload(sessionUri, size) {
    const res = await this.request(sessionUri, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' },
      accept: (r) => r.status === 308,
    });
    return DriveClient.uploadState(res);
  }

  // Sends bytes [start, end) streamed from `iterable` (an async iterable of Buffers).
  async uploadChunk(sessionUri, { iterable, start, end, size, signal }) {
    const range = size === 0 ? `bytes */0` : `bytes ${start}-${end - 1}/${size}`;
    const res = await this.request(sessionUri, {
      method: 'PUT',
      headers: { 'Content-Range': range, 'Content-Length': String(end - start) },
      body: size === 0 ? '' : iterable,
      duplex: size === 0 ? undefined : 'half',
      signal,
      retries: 0,
      accept: (r) => r.status === 308,
    });
    return DriveClient.uploadState(res);
  }
}

module.exports = {
  DriveClient,
  DriveError,
  FOLDER_MIME,
  SHORTCUT_MIME,
  isGoogleNative,
  exportTarget,
  parseContentDisposition,
  sleep,
  backoff,
};
