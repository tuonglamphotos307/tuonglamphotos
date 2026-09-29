'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DriveClient, parseContentDisposition, exportTarget } = require('../src/main/drive');

// Replaces global fetch with a scripted fake for the duration of one test.
function withFetch(t, handler) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts, calls.length);
  };
  t.after(() => {
    global.fetch = real;
  });
  return calls;
}

function client({ loggedIn = true } = {}) {
  let refreshes = 0;
  const auth = {
    isLoggedIn: () => loggedIn,
    getAccessToken: async (force) => {
      if (force) refreshes++;
      return `tok${refreshes}`;
    },
    get refreshes() {
      return refreshes;
    },
  };
  const settings = { get: (k) => ({ maxRetries: 3, apiKey: '' })[k] };
  return { drive: new DriveClient({ auth, settings }), auth };
}

const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

test('retries 503 and rate limits, then succeeds', { timeout: 20000 }, async (t) => {
  const calls = withFetch(t, (_url, _o, n) => {
    if (n === 1) return json({ error: { code: 503, message: 'busy' } }, 503);
    if (n === 2) return json({ error: { code: 403, message: 'slow down', errors: [{ reason: 'userRateLimitExceeded' }] } }, 403);
    return json({ id: 'f1', name: 'x' });
  });
  const { drive } = client();
  const meta = await drive.get('f1');
  assert.equal(meta.id, 'f1');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok0');
});

test('refreshes the token once on 401', async (t) => {
  withFetch(t, (_url, opts) => (opts.headers.Authorization === 'Bearer tok0' ? json({ error: { code: 401 } }, 401) : json({ ok: 1 })));
  const { drive, auth } = client();
  const out = await drive.json('/about');
  assert.deepEqual(out, { ok: 1 });
  assert.equal(auth.refreshes, 1);
});

test('non-retryable errors surface a friendly message', async (t) => {
  withFetch(t, () => json({ error: { code: 404, message: 'File not found: x.', errors: [{ reason: 'notFound' }] } }, 404));
  const { drive } = client();
  await assert.rejects(drive.get('x'), (e) => e.status === 404 && /Không tìm thấy/.test(e.message));
});

test('sends resource keys header', async (t) => {
  const calls = withFetch(t, () => json({ id: 'f1' }));
  const { drive } = client();
  await drive.get('f1', '0-key');
  assert.equal(calls[0].opts.headers['X-Goog-Drive-Resource-Keys'], 'f1/0-key');
});

test('public download passes the virus-scan interstitial', async (t) => {
  const page = `<html><form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
    <input type="hidden" name="id" value="abc"><input type="hidden" name="export" value="download">
    <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-123"></form></html>`;
  const calls = withFetch(t, (url) => {
    if (!url.includes('uuid=')) return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('BINARY', { headers: { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename=\"a.zip\"; filename*=UTF-8''%E1%BA%A2nh.zip" } });
  });
  const { drive } = client({ loggedIn: false });
  const res = await drive.publicMedia('abc');
  assert.equal(await res.text(), 'BINARY');
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /uuid=u-123/);
  assert.equal(parseContentDisposition(res.headers.get('content-disposition')), 'Ảnh.zip');
});

test('public download reports private files', async (t) => {
  withFetch(t, () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }));
  const { drive } = client({ loggedIn: false });
  await assert.rejects(drive.publicMedia('abc'), /không được chia sẻ công khai/);
});

test('resumable upload: start, query offset, finish', async (t) => {
  withFetch(t, (url, opts) => {
    if (opts.method === 'POST') return new Response(null, { status: 200, headers: { location: 'https://upload/session1' } });
    if (opts.headers['Content-Range'] === 'bytes */100') return new Response(null, { status: 308, headers: { range: 'bytes=0-39' } });
    return json({ id: 'done-id' }, 200);
  });
  const { drive } = client();
  const uri = await drive.startUpload({ name: 'a.bin', parentId: 'p', size: 100 });
  assert.equal(uri, 'https://upload/session1');
  assert.deepEqual(await drive.queryUpload(uri, 100), { done: false, offset: 40 });
  const r = await drive.uploadChunk(uri, { iterable: [Buffer.alloc(60)], start: 40, end: 100, size: 100 });
  assert.deepEqual(r, { done: true, file: { id: 'done-id' } });
});

test('export targets', () => {
  assert.equal(exportTarget('application/vnd.google-apps.document')[1], '.docx');
  assert.equal(exportTarget('application/vnd.google-apps.spreadsheet', 'pdf')[1], '.pdf');
  assert.equal(exportTarget('application/vnd.google-apps.form'), null);
});
