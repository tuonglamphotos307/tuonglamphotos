'use strict';

// Google OAuth 2.0 for installed apps: loopback redirect + PKCE.
// https://developers.google.com/identity/protocols/oauth2/native-app

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPES = ['https://www.googleapis.com/auth/drive', 'openid', 'email', 'profile'];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const PAGE = (title, msg) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;background:#0f1412;color:#e6ece9;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2 style="color:#3ddc97">${title}</h2><p>${msg}</p></div></body>`;

class Auth {
  // crypto: { encrypt(string) -> Buffer, decrypt(Buffer) -> string } (Electron safeStorage in the app)
  constructor({ dir, settings, openExternal, crypto: box }) {
    this.file = path.join(dir, 'token.bin');
    this.settings = settings;
    this.openExternal = openExternal;
    this.box = box;
    this.tokens = null; // { access_token, refresh_token, expires_at }
    this.user = null;
    this.refreshing = null;
    this.pendingLogin = null;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file);
      const data = JSON.parse(this.box.decrypt(raw));
      this.tokens = data.tokens;
      this.user = data.user || null;
    } catch {
      this.tokens = null;
    }
  }

  _save() {
    if (!this.tokens) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, this.box.encrypt(JSON.stringify({ tokens: this.tokens, user: this.user })));
  }

  _client() {
    const clientId = (this.settings.get('clientId') || '').trim();
    const clientSecret = (this.settings.get('clientSecret') || '').trim();
    if (!clientId) {
      const err = new Error('Chưa cấu hình OAuth Client ID. Mở Cài đặt để nhập Client ID/Secret.');
      err.code = 'NO_CLIENT';
      throw err;
    }
    return { clientId, clientSecret };
  }

  isLoggedIn() {
    return Boolean(this.tokens && this.tokens.refresh_token);
  }

  status() {
    return {
      loggedIn: this.isLoggedIn(),
      user: this.user,
      configured: Boolean((this.settings.get('clientId') || '').trim()),
    };
  }

  async login() {
    const { clientId, clientSecret } = this._client();
    if (this.pendingLogin) this.pendingLogin.cancel();

    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const code = await new Promise((resolve, reject) => {
      let redirectUri;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const err = url.searchParams.get('error');
        if (err || url.searchParams.get('state') !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(PAGE('Đăng nhập thất bại', 'Anh có thể đóng tab này và thử lại trong DriveDock.'));
          finish(new Error(err === 'access_denied' ? 'Anh đã huỷ đăng nhập.' : `Đăng nhập thất bại: ${err || 'state không khớp'}`));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE('Đã kết nối Google Drive', 'Anh có thể đóng tab này và quay lại DriveDock.'));
        finish(null, url.searchParams.get('code'));
      });

      const timer = setTimeout(() => finish(new Error('Hết thời gian chờ đăng nhập.')), LOGIN_TIMEOUT_MS);
      const finish = (error, value) => {
        clearTimeout(timer);
        server.close();
        this.pendingLogin = null;
        if (error) reject(error);
        else resolve({ value, redirectUri });
      };
      this.pendingLogin = { cancel: () => finish(new Error('Đăng nhập đã bị huỷ.')) };

      server.on('error', (e) => finish(e));
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES.join(' '),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent',
        });
        this.openExternal(`${AUTH_URL}?${params}`);
      });
    });

    const body = new URLSearchParams({
      client_id: clientId,
      code: code.value,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: code.redirectUri,
    });
    if (clientSecret) body.set('client_secret', clientSecret);
    const tok = await this._tokenRequest(body);
    this.tokens = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
    };
    this.user = await this._fetchUser();
    this._save();
    return this.status();
  }

  async _tokenRequest(body) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error_description || data.error || `Token HTTP ${res.status}`);
      err.oauthError = data.error;
      throw err;
    }
    return data;
  }

  async _fetchUser() {
    try {
      const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
        headers: { Authorization: `Bearer ${this.tokens.access_token}` },
      });
      const data = await res.json();
      return data.user || null;
    } catch {
      return null;
    }
  }

  // Returns a valid access token, refreshing it when it is about to expire. Concurrent callers share one refresh.
  async getAccessToken(force = false) {
    if (!this.isLoggedIn()) {
      const err = new Error('Chưa đăng nhập Google Drive.');
      err.code = 'NOT_LOGGED_IN';
      throw err;
    }
    if (!force && this.tokens.access_token && this.tokens.expires_at - Date.now() > 60_000) {
      return this.tokens.access_token;
    }
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const { clientId, clientSecret } = this._client();
        const body = new URLSearchParams({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: this.tokens.refresh_token,
        });
        if (clientSecret) body.set('client_secret', clientSecret);
        try {
          const tok = await this._tokenRequest(body);
          this.tokens.access_token = tok.access_token;
          this.tokens.expires_at = Date.now() + (tok.expires_in || 3600) * 1000;
          if (tok.refresh_token) this.tokens.refresh_token = tok.refresh_token;
          this._save();
          return this.tokens.access_token;
        } catch (e) {
          if (e.oauthError === 'invalid_grant') {
            // Refresh token revoked or expired (e.g. 7-day limit for apps in "Testing"): force a new login.
            this.tokens = null;
            this.user = null;
            this._save();
            e.code = 'NOT_LOGGED_IN';
            e.message = 'Phiên đăng nhập Google đã hết hạn. Vui lòng kết nối lại.';
          }
          throw e;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  async logout() {
    const token = this.tokens && (this.tokens.refresh_token || this.tokens.access_token);
    this.tokens = null;
    this.user = null;
    this._save();
    if (token) {
      fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
    }
    return this.status();
  }
}

module.exports = { Auth };
