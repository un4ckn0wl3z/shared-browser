import { createServer } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpBrowser, findChrome } from './cdp-browser.mjs';
import { GitHubApiError, GitHubBroker, normalizeRepository } from './github-api.mjs';
import { githubGuestPage, guestLoginPage, guestPage, ownerLoginPage, ownerPage } from './web.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
mkdirSync(dataDir, { recursive: true });

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 17890);
const debugPort = Number(process.env.CHROME_DEBUG_PORT || 19222);
const browserEnabled = process.env.BROWSER_ENABLED !== '0';
const initialUrl = process.env.INITIAL_URL || 'https://www.facebook.com/';
const maxBrowserSessions = Math.min(20, Math.max(1, Number(process.env.MAX_BROWSER_SESSIONS || 5)));
const configuredMaxGuests = Number(process.env.MAX_GUESTS_PER_LINK || 20);
const maxGuestsPerLink = Math.min(100, Math.max(1, Number.isFinite(configuredMaxGuests) ? configuredMaxGuests : 20));
const guestActiveWindowMs = 30000;
const guestTokenLifetimeMs = 12 * 60 * 60 * 1000;
const ownerPassword = process.env.OWNER_PASSWORD || randomBytes(18).toString('base64url');
const ownerDigest = createHash('sha256').update(ownerPassword).digest();
const allowedHosts = (process.env.ALLOWED_HOSTS || 'facebook.com,fb.com,messenger.com,meta.com').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
const ownerTokens = new Map();
const shares = new Map();
const authAttempts = new Map();
const browsers = new Map();
const browserConfigPath = join(dataDir, 'browser-sessions.json');
const shareConfigPath = join(dataDir, 'shares.json');
const auditLogPath = join(dataDir, 'audit.log');
const github = new GitHubBroker();
let browserConfigs = [];
let shuttingDown = false;

function loadBrowserConfigs() {
  if (existsSync(browserConfigPath)) {
    const loaded = JSON.parse(readFileSync(browserConfigPath, 'utf8'));
    if (Array.isArray(loaded) && loaded.length) return loaded.slice(0, maxBrowserSessions);
  }
  return [{ id: 'default', name: 'Default', initialUrl }];
}
function saveBrowserConfigs() {
  writeFileSync(browserConfigPath, `${JSON.stringify(browserConfigs, null, 2)}\n`, { mode: 0o600 });
}
function loadShares() {
  if (!existsSync(shareConfigPath)) return;
  try {
    const loaded = JSON.parse(readFileSync(shareConfigPath, 'utf8'));
    if (!Array.isArray(loaded)) throw new Error('expected an array');
    for (const item of loaded) {
      const expires = item.expires === null ? null : Number(item.expires);
      const salt = Buffer.from(String(item.salt || ''), 'base64');
      const hash = Buffer.from(String(item.hash || ''), 'base64');
      if (!/^[A-Za-z0-9_-]{20,}$/.test(String(item.id || ''))) continue;
      const targetType = item.targetType === 'github' ? 'github' : 'browser';
      const repository = targetType === 'github' ? normalizeRepository(item.repository) : null;
      if (targetType === 'browser' && !browserConfigs.some((config) => config.id === item.browserSessionId)) continue;
      if (targetType === 'github' && !repository) continue;
      if (expires !== null && (!Number.isFinite(expires) || expires <= Date.now())) continue;
      if (salt.length !== 16 || hash.length !== 32) continue;
      shares.set(item.id, {
        mode: item.mode === 'view' ? 'view' : 'control',
        targetType,
        browserSessionId: targetType === 'browser' ? item.browserSessionId : null,
        repository,
        expires,
        salt,
        hash,
        revoked: false,
        guests: new Map()
      });
    }
  } catch (error) {
    console.warn(`Could not load persistent share links: ${error.message}`);
  }
}
function saveShares() {
  const now = Date.now();
  const persistent = [...shares.entries()]
    .filter(([, share]) => !share.revoked && (share.expires === null || share.expires > now))
    .map(([id, share]) => ({
      id,
      mode: share.mode,
      targetType: share.targetType,
      browserSessionId: share.browserSessionId,
      repository: share.repository,
      expires: share.expires,
      salt: share.salt.toString('base64'),
      hash: share.hash.toString('base64')
    }));
  writeFileSync(shareConfigPath, `${JSON.stringify(persistent, null, 2)}\n`, { mode: 0o600 });
}
function browserProfileDir(id) {
  return id === 'default' ? join(dataDir, 'browser-profile') : join(dataDir, 'browser-profiles', id);
}
function audit(entry) {
  try {
    appendFileSync(auditLogPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`Could not write audit log: ${error.message}`);
  }
}
function addOwnerAllowedHost(browser, urlValue) {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol === 'https:') browser.ownerAllowedHosts.add(parsed.hostname.toLowerCase());
  } catch {}
}

function json(res, status, payload, headers = {}) {
  const body = payload === null ? '' : JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}
function githubFailure(res, error) {
  if (error instanceof GitHubApiError) {
    const status = [400, 403, 404, 409, 422, 503].includes(error.status) ? error.status : 502;
    return json(res, status, { error: error.message });
  }
  throw error;
}
function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
  res.end(body);
}
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((entry) => entry.trim().split('=').map(decodeURIComponent)).filter((parts) => parts.length === 2));
}
function cookie(req, name, value, maxAge = 3600) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 96 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function passwordRecord(password) {
  const salt = randomBytes(16);
  return { salt, hash: scryptSync(password, salt, 32) };
}
function passwordMatches(password, record) {
  const actual = scryptSync(String(password || ''), record.salt, 32);
  return actual.length === record.hash.length && timingSafeEqual(actual, record.hash);
}
function ownerAuthorized(req) {
  const token = parseCookies(req).ss_owner;
  const entry = token && ownerTokens.get(token);
  if (!entry || entry < Date.now()) { if (token) ownerTokens.delete(token); return false; }
  ownerTokens.set(token, Date.now() + 12 * 60 * 60 * 1000);
  return true;
}
function liveShare(id) {
  const share = shares.get(id);
  if (!share || share.revoked || (share.expires !== null && share.expires <= Date.now())) return null;
  return share;
}
function activeGuestSummaries(share, now = Date.now()) {
  for (const [token, guest] of share.guests.entries()) {
    if (now - guest.lastSeen > guestTokenLifetimeMs) share.guests.delete(token);
  }
  return [...share.guests.values()]
    .filter((guest) => now - guest.lastSeen < guestActiveWindowMs)
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((guest) => ({ name: guest.name, joinedAt: guest.joinedAt }));
}
function guestAuthorized(req, id, touch = true) {
  const share = liveShare(id);
  const token = parseCookies(req).ss_guest;
  const guest = share && token ? share.guests.get(token) : null;
  if (!share || !token || !guest) return null;
  const now = Date.now();
  const wasActive = now - guest.lastSeen < guestActiveWindowMs;
  if (touch && !wasActive && activeGuestSummaries(share, now).length >= maxGuestsPerLink) return null;
  if (touch) guest.lastSeen = now;
  return share;
}
function publicBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
function authKey(req, scope) {
  const remote = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : req.socket.remoteAddress;
  return `${scope}:${remote || 'unknown'}`;
}
function authAllowed(key) {
  const entry = authAttempts.get(key);
  if (!entry || entry.resetAt <= Date.now()) { authAttempts.delete(key); return true; }
  return entry.count < 10;
}
function authFailed(key) {
  const now = Date.now();
  const entry = authAttempts.get(key);
  if (!entry || entry.resetAt <= now) authAttempts.set(key, { count: 1, resetAt: now + 10 * 60 * 1000 });
  else entry.count += 1;
}
function authSucceeded(key) { authAttempts.delete(key); }
function hasActiveGuest(browserSessionId) {
  const now = Date.now();
  return [...shares.values()].some((share) => share.targetType === 'browser' && share.browserSessionId === browserSessionId && !share.revoked && (share.expires === null || share.expires > now) && activeGuestSummaries(share, now).length > 0);
}
function allowed(browser, urlValue) {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol === 'about:' || parsed.protocol === 'chrome:') return true;
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return browser.ownerAllowedHosts.has(hostname) || allowedHosts.includes('*') || allowedHosts.some((hostValue) => hostname === hostValue || hostname.endsWith(`.${hostValue}`));
  } catch { return false; }
}

function allocateDebugPort() {
  const used = new Set([...browsers.values()].map((instance) => instance.debuggingPort));
  for (let candidate = debugPort; candidate < debugPort + maxBrowserSessions; candidate += 1) {
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('No Chromium debugging port is available');
}

async function launchBrowser(config) {
  const instance = new CdpBrowser({
    executable: findChrome(),
    profileDir: browserProfileDir(config.id),
    debuggingPort: allocateDebugPort(),
    initialUrl: config.initialUrl || initialUrl,
    headless: process.env.HEADLESS === '1'
  });
  instance.ownerAllowedHosts = new Set();
  addOwnerAllowedHost(instance, config.initialUrl || initialUrl);
  try {
    await instance.start();
  } catch (error) {
    await instance.stop();
    throw error;
  }
  instance.onUrl = async (url) => {
    if (!hasActiveGuest(config.id) || allowed(instance, url)) {
      if (allowed(instance, url)) instance.lastAllowedUrl = url;
      return;
    }
    console.warn(`Blocked guest navigation in ${config.name} to ${url}`);
    await instance.browserAction('navigate', instance.lastAllowedUrl || config.initialUrl || initialUrl).catch(() => {});
  };
  browsers.set(config.id, instance);
  return instance;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, browsers: browsers.size, ready: [...browsers.values()].filter((item) => item.frame).length });
    if (req.method === 'GET' && path === '/') return html(res, 200, ownerAuthorized(req) ? ownerPage() : ownerLoginPage());
    if (req.method === 'GET' && path === '/owner') {
      if (!ownerAuthorized(req)) { res.writeHead(302, { location: '/' }); return res.end(); }
      return html(res, 200, ownerPage());
    }
    if (req.method === 'GET' && path.startsWith('/static/')) {
      const name = path.slice('/static/'.length);
      if (!['client.js', 'style.css'].includes(name)) return json(res, 404, { error: 'Not found' });
      const content = readFileSync(join(root, 'public', name));
      res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      return res.end(content);
    }
    if (req.method === 'POST' && path === '/api/owner/login') {
      const attemptKey = authKey(req, 'owner');
      if (!authAllowed(attemptKey)) return json(res, 429, { error: 'Too many login attempts. Try again later.' });
      const input = await body(req);
      const supplied = createHash('sha256').update(String(input.password || '')).digest();
      if (!timingSafeEqual(ownerDigest, supplied)) { authFailed(attemptKey); return json(res, 401, { error: 'Incorrect owner password' }); }
      authSucceeded(attemptKey);
      const token = randomBytes(32).toString('base64url');
      ownerTokens.set(token, Date.now() + 12 * 60 * 60 * 1000);
      return json(res, 200, { ok: true }, { 'set-cookie': cookie(req, 'ss_owner', token, 12 * 60 * 60) });
    }
    if (req.method === 'POST' && path === '/api/owner/logout') {
      const token = parseCookies(req).ss_owner; if (token) ownerTokens.delete(token);
      return json(res, 200, { ok: true }, { 'set-cookie': cookie(req, 'ss_owner', '', 0) });
    }
    if (req.method === 'GET' && path === '/api/status') {
      if (!ownerAuthorized(req)) return json(res, 401, { error: 'Unauthorized' });
      const now = Date.now();
      const active = [...shares.entries()].filter(([, share]) => !share.revoked && (share.expires === null || share.expires > now)).map(([id, share]) => {
        const guests = activeGuestSummaries(share, now);
        return {
          id, mode: share.mode, targetType: share.targetType, repository: share.repository, expires: share.expires, permanent: share.expires === null, browserSessionId: share.browserSessionId,
          targetName: share.targetType === 'github' ? `GitHub · ${share.repository}` : browserConfigs.find((item) => item.id === share.browserSessionId)?.name || share.browserSessionId,
          browserSessionName: browserConfigs.find((item) => item.id === share.browserSessionId)?.name || share.browserSessionId,
          connected: guests.length > 0, guestCount: guests.length, guests, url: `${publicBase(req)}/s/${id}`
        };
      });
      const sessions = browserConfigs.map((config) => {
        const instance = browsers.get(config.id);
        return { id: config.id, name: config.name, initialUrl: config.initialUrl, browserUrl: instance?.currentUrl || null, connected: Boolean(instance?.socket && instance.socket.readyState === WebSocket.OPEN) };
      });
      return json(res, 200, { browserEnabled, browserConnected: sessions.some((item) => item.connected), sessions, shares: active, maxBrowserSessions, maxGuestsPerLink, githubConfigured: github.configured });
    }
    if (req.method === 'POST' && path === '/api/browser-sessions') {
      if (!ownerAuthorized(req)) return json(res, 401, { error: 'Unauthorized' });
      if (!browserEnabled) return json(res, 503, { error: 'Browser mode is disabled on this server' });
      if (browserConfigs.length >= maxBrowserSessions) return json(res, 409, { error: `Maximum browser sessions reached (${maxBrowserSessions})` });
      const input = await body(req);
      const name = String(input.name || '').trim().slice(0, 50);
      let startUrl = String(input.initialUrl || 'https://www.facebook.com/').trim();
      if (!/^https:\/\//i.test(startUrl)) startUrl = `https://${startUrl}`;
      try { startUrl = new URL(startUrl).href; } catch { return json(res, 400, { error: 'Invalid initial URL' }); }
      if (!name) return json(res, 400, { error: 'Session name is required' });
      const config = { id: randomBytes(9).toString('base64url'), name, initialUrl: startUrl };
      await launchBrowser(config);
      browserConfigs.push(config);
      saveBrowserConfigs();
      return json(res, 201, { id: config.id, name: config.name, initialUrl: config.initialUrl });
    }
    const browserSessionDeleteMatch = path.match(/^\/api\/browser-sessions\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'DELETE' && browserSessionDeleteMatch) {
      if (!ownerAuthorized(req)) return json(res, 401, { error: 'Unauthorized' });
      const browserSessionId = browserSessionDeleteMatch[1];
      if (browserSessionId === 'default') return json(res, 400, { error: 'The Default browser session cannot be deleted' });
      const instance = browsers.get(browserSessionId);
      if (!instance) return json(res, 404, { error: 'Browser session not found' });
      let sharesChanged = false;
      for (const [id, share] of shares.entries()) {
        if (share.browserSessionId === browserSessionId) { shares.delete(id); sharesChanged = true; }
      }
      if (sharesChanged) saveShares();
      await instance.stop();
      browsers.delete(browserSessionId);
      browserConfigs = browserConfigs.filter((item) => item.id !== browserSessionId);
      saveBrowserConfigs();
      return json(res, 200, { ok: true, profileRetained: true });
    }
    if (req.method === 'POST' && path === '/api/shares') {
      if (!ownerAuthorized(req)) return json(res, 401, { error: 'Unauthorized' });
      const input = await body(req);
      const password = String(input.password || '');
      const minutes = Math.min(1440, Math.max(1, Number(input.minutes) || 30));
      const permanent = input.permanent === true || input.permanent === 'true' || input.permanent === 'on';
      const mode = input.mode === 'view' ? 'view' : 'control';
      const targetType = input.targetType === 'github' ? 'github' : 'browser';
      const browserSessionId = targetType === 'browser' ? String(input.browserSession || '') : null;
      const repository = targetType === 'github' ? normalizeRepository(input.repository) : null;
      if (password.length < 6) return json(res, 400, { error: 'Guest password must contain at least 6 characters' });
      if (targetType === 'browser' && !browsers.has(browserSessionId)) return json(res, 400, { error: 'Select a running browser session' });
      if (targetType === 'github') {
        if (!repository) return json(res, 400, { error: 'Enter a GitHub repository as owner/name' });
        try { await github.overview(repository); } catch (error) { return githubFailure(res, error); }
      }
      const id = randomBytes(24).toString('base64url');
      shares.set(id, { ...passwordRecord(password), mode, targetType, browserSessionId, repository, expires: permanent ? null : Date.now() + minutes * 60000, revoked: false, guests: new Map() });
      saveShares();
      return json(res, 201, { id, mode, targetType, repository, expires: shares.get(id).expires, permanent, url: `${publicBase(req)}/s/${id}` });
    }
    const deleteMatch = path.match(/^\/api\/shares\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      if (!ownerAuthorized(req)) return json(res, 401, { error: 'Unauthorized' });
      shares.delete(deleteMatch[1]);
      saveShares();
      return json(res, 200, { ok: true });
    }
    const sharePageMatch = path.match(/^\/s\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && sharePageMatch) {
      const share = liveShare(sharePageMatch[1]);
      if (!share) return html(res, 410, '<!doctype html><meta charset="utf-8"><title>Link expired</title><h1>This link has expired or was revoked.</h1>');
      const authorized = guestAuthorized(req, sharePageMatch[1]);
      if (!authorized) return html(res, 200, guestLoginPage(sharePageMatch[1], share.mode, share.targetType, share.repository));
      return html(res, 200, share.targetType === 'github' ? githubGuestPage(sharePageMatch[1], share.mode, share.repository) : guestPage(sharePageMatch[1], share.mode));
    }
    const loginMatch = path.match(/^\/api\/s\/([A-Za-z0-9_-]+)\/login$/);
    if (req.method === 'POST' && loginMatch) {
      const share = liveShare(loginMatch[1]);
      if (!share) return json(res, 410, { error: 'This link has expired or was revoked' });
      const attemptKey = authKey(req, `guest:${loginMatch[1]}`);
      if (!authAllowed(attemptKey)) return json(res, 429, { error: 'Too many login attempts. Try again later.' });
      const input = await body(req);
      const guestName = String(input.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!guestName) return json(res, 400, { error: 'Enter your display name' });
      if (!passwordMatches(input.password, share)) { authFailed(attemptKey); return json(res, 401, { error: 'Incorrect access password' }); }
      authSucceeded(attemptKey);
      const now = Date.now();
      const activeGuests = activeGuestSummaries(share, now);
      if (activeGuests.length >= maxGuestsPerLink) return json(res, 409, { error: `This link already has ${maxGuestsPerLink} active users` });
      if (activeGuests.some((guest) => guest.name.toLowerCase() === guestName.toLowerCase())) return json(res, 409, { error: 'That display name is already in use on this link' });
      const token = randomBytes(32).toString('base64url');
      share.guests.set(token, { name: guestName, joinedAt: now, lastSeen: now });
      const guestCookieSeconds = share.expires === null ? 12 * 60 * 60 : Math.max(1, Math.ceil((share.expires - Date.now()) / 1000));
      return json(res, 200, { ok: true, name: guestName }, { 'set-cookie': cookie(req, 'ss_guest', token, guestCookieSeconds) });
    }
    const logoutMatch = path.match(/^\/api\/s\/([A-Za-z0-9_-]+)\/logout$/);
    if (req.method === 'POST' && logoutMatch) {
      const share = liveShare(logoutMatch[1]);
      const token = parseCookies(req).ss_guest;
      if (share && token) share.guests.delete(token);
      return json(res, 200, { ok: true }, { 'set-cookie': cookie(req, 'ss_guest', '', 0) });
    }
    const guestStatusMatch = path.match(/^\/api\/s\/([A-Za-z0-9_-]+)\/status$/);
    if (req.method === 'GET' && guestStatusMatch) {
      const share = guestAuthorized(req, guestStatusMatch[1]);
      if (!share) return json(res, 401, { error: 'Unauthorized' });
      const guests = activeGuestSummaries(share);
      if (share.targetType === 'github') return json(res, 200, { targetType: 'github', repository: share.repository, mode: share.mode, guestCount: guests.length, guests, maxGuestsPerLink });
      const instance = browsers.get(share.browserSessionId);
      if (!instance) return json(res, 404, { error: 'Browser session not found' });
      return json(res, 200, { targetType: 'browser', browserUrl: instance.currentUrl, mode: share.mode, guestCount: guests.length, guests, maxGuestsPerLink });
    }
    const githubOverviewMatch = path.match(/^\/api\/s\/([A-Za-z0-9_-]+)\/github\/overview$/);
    if (req.method === 'GET' && githubOverviewMatch) {
      const share = guestAuthorized(req, githubOverviewMatch[1]);
      if (!share) return json(res, 401, { error: 'Unauthorized' });
      if (share.targetType !== 'github') return json(res, 404, { error: 'GitHub mode is not enabled for this link' });
      try { return json(res, 200, await github.overview(share.repository)); } catch (error) { return githubFailure(res, error); }
    }
    const githubIssuesMatch = path.match(/^\/api\/s\/([A-Za-z0-9_-]+)\/github\/issues$/);
    if (req.method === 'POST' && githubIssuesMatch) {
      const share = guestAuthorized(req, githubIssuesMatch[1]);
      if (!share) return json(res, 401, { error: 'Unauthorized' });
      if (share.targetType !== 'github') return json(res, 404, { error: 'GitHub mode is not enabled for this link' });
      if (share.mode !== 'control') return json(res, 403, { error: 'This link is read-only' });
      const input = await body(req);
      const title = String(input.title || '').trim().slice(0, 256);
      const issueBody = String(input.body || '').slice(0, 65536);
      if (!title) return json(res, 400, { error: 'Issue title is required' });
      try {
        const result = await github.createIssue(share.repository, title, issueBody);
        const guest = share.guests.get(parseCookies(req).ss_guest);
        audit({ actor: guest?.name || 'unknown', action: 'github.issue.create', repository: share.repository, issue: result.number, shareId: githubIssuesMatch[1] });
        return json(res, 201, { number: result.number, htmlUrl: result.html_url });
      } catch (error) { return githubFailure(res, error); }
    }
    const githubCommentMatch = path.match(/^\/api\/s\/([A-Za-z0-9_-]+)\/github\/issues\/(\d+)\/comments$/);
    if (req.method === 'POST' && githubCommentMatch) {
      const share = guestAuthorized(req, githubCommentMatch[1]);
      if (!share) return json(res, 401, { error: 'Unauthorized' });
      if (share.targetType !== 'github') return json(res, 404, { error: 'GitHub mode is not enabled for this link' });
      if (share.mode !== 'control') return json(res, 403, { error: 'This link is read-only' });
      const input = await body(req);
      const commentBody = String(input.body || '').trim().slice(0, 65536);
      if (!commentBody) return json(res, 400, { error: 'Comment cannot be empty' });
      const issueNumber = Number(githubCommentMatch[2]);
      try {
        const result = await github.createComment(share.repository, issueNumber, commentBody);
        const guest = share.guests.get(parseCookies(req).ss_guest);
        audit({ actor: guest?.name || 'unknown', action: 'github.comment.create', repository: share.repository, issue: issueNumber, commentId: result.id, shareId: githubCommentMatch[1] });
        return json(res, 201, { id: result.id, htmlUrl: result.html_url });
      } catch (error) { return githubFailure(res, error); }
    }
    if (req.method === 'GET' && path === '/api/frame') {
      const id = url.searchParams.get('session');
      const owner = ownerAuthorized(req);
      const share = id ? guestAuthorized(req, id) : null;
      if (!owner && !share) return json(res, 401, { error: 'Unauthorized' });
      const browserSessionId = owner ? String(url.searchParams.get('browserSession') || browserConfigs[0]?.id || '') : share.browserSessionId;
      const instance = browsers.get(browserSessionId);
      if (!instance?.frame) return json(res, 503, { error: 'No browser frame yet' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': instance.frame.length, 'cache-control': 'no-store, max-age=0', 'x-frame-revision': String(instance.frameRevision) });
      return res.end(instance.frame);
    }
    if (req.method === 'POST' && path === '/api/input') {
      const input = await body(req);
      const owner = ownerAuthorized(req);
      const share = input.session ? guestAuthorized(req, input.session) : null;
      if (!owner && !share) return json(res, 401, { error: 'Unauthorized' });
      if (!owner && share.mode !== 'control') return json(res, 403, { error: 'View-only session' });
      const browserSessionId = owner ? String(input.browserSession || browserConfigs[0]?.id || '') : share.browserSessionId;
      const instance = browsers.get(browserSessionId);
      if (!instance) return json(res, 404, { error: 'Browser session not found' });
      await instance.input(input);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/browser/action') {
      const input = await body(req);
      const owner = ownerAuthorized(req);
      const share = input.session ? guestAuthorized(req, input.session) : null;
      if (!owner && !share) return json(res, 401, { error: 'Unauthorized' });
      if (!owner && share.mode !== 'control') return json(res, 403, { error: 'View-only session' });
      const browserSessionId = owner ? String(input.browserSession || browserConfigs[0]?.id || '') : share.browserSessionId;
      const instance = browsers.get(browserSessionId);
      if (!instance) return json(res, 404, { error: 'Browser session not found' });
      if (input.action === 'navigate') {
        let value = String(input.value || '').trim();
        if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
        let parsed;
        try { parsed = new URL(value); } catch { return json(res, 400, { error: 'Invalid URL' }); }
        if (parsed.protocol !== 'https:') return json(res, 400, { error: 'Only HTTPS websites are allowed' });
        input.value = value;
        addOwnerAllowedHost(instance, value);
      }
      await instance.browserAction(input.action, input.value);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/clipboard/read') {
      const input = await body(req);
      const owner = ownerAuthorized(req);
      const share = input.session ? guestAuthorized(req, input.session) : null;
      if (!owner && !share) return json(res, 401, { error: 'Unauthorized' });
      const browserSessionId = owner ? String(input.browserSession || browserConfigs[0]?.id || '') : share.browserSessionId;
      const instance = browsers.get(browserSessionId);
      if (!instance) return json(res, 404, { error: 'Browser session not found' });
      return json(res, 200, { text: await instance.selectedText() });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: 'Internal server error' });
  }
}

async function main() {
  const executable = browserEnabled ? findChrome() : null;
  if (browserEnabled && !executable) throw new Error('Chrome/Chromium was not found. Install Chromium or set CHROME_BIN to its absolute path.');
  browserConfigs = loadBrowserConfigs();
  saveBrowserConfigs();
  loadShares();
  if (browserEnabled) {
    for (const config of browserConfigs) await launchBrowser(config);
  }

  const server = createServer(route);
  server.requestTimeout = 15000;
  server.headersTimeout = 17000;
  server.listen(port, host, () => {
    console.log(`\nSession Share Server is running`);
    console.log(`Owner console: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`);
    console.log(`Owner password: ${ownerPassword}`);
    console.log(`Chromium: ${browserEnabled ? executable : 'disabled (API-only mode)'}`);
    console.log(`Browser sessions: ${browsers.size}/${maxBrowserSessions}`);
    if (host !== '127.0.0.1' && host !== '::1') console.warn('WARNING: Public HTTP is not encrypted. Put this server behind HTTPS before sharing it.');
  });

  const stop = async () => {
    if (shuttingDown) return; shuttingDown = true;
    console.log('\nStopping…');
    server.close();
    await Promise.allSettled([...browsers.values()].map((instance) => instance.stop()));
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(async (error) => {
  console.error(`Startup failed: ${error.message}`);
  await Promise.allSettled([...browsers.values()].map((instance) => instance.stop()));
  process.exit(1);
});
