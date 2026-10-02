const page = document.body.dataset.page;
const sessionId = document.body.dataset.sessionId;
const mode = document.body.dataset.mode;
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

if (page === 'owner-login') {
  document.querySelector('#owner-login').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = document.querySelector('#message');
    message.textContent = '';
    try {
      await api('/api/owner/login', { method: 'POST', body: JSON.stringify({ password: new FormData(event.target).get('password') }) });
      location.href = '/owner';
    } catch (error) { message.textContent = error.message; }
  });
}

if (page === 'guest-login') {
  document.querySelector('#guest-login').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = document.querySelector('#message');
    message.textContent = '';
    try {
      const form = new FormData(event.target);
      await api(`/api/s/${encodeURIComponent(sessionId)}/login`, { method: 'POST', body: JSON.stringify({ name: form.get('name'), password: form.get('password') }) });
      location.reload();
    } catch (error) { message.textContent = error.message; }
  });
}

function modifiers(event) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

function startViewer(canControl, browserSession = () => null) {
  const viewer = document.querySelector('#viewer');
  const screen = document.querySelector('#screen');
  const status = document.querySelector('#viewer-status');
  let stopped = false;
  let frameVersion = 0;
  let moving = false;
  let lastMove = 0;

  async function loadFrame() {
    if (stopped) return;
    const selectedBrowser = browserSession();
    const suffix = sessionId
      ? `?session=${encodeURIComponent(sessionId)}&v=${frameVersion++}`
      : `?browserSession=${encodeURIComponent(selectedBrowser || '')}&v=${frameVersion++}`;
    screen.onload = () => {
      status.hidden = true;
      setTimeout(loadFrame, 80);
    };
    screen.onerror = () => {
      status.hidden = false;
      status.textContent = 'Waiting for browser…';
      setTimeout(loadFrame, 800);
    };
    screen.src = `/api/frame${suffix}`;
  }
  loadFrame();

  const authPayload = () => ({ session: sessionId || undefined, browserSession: browserSession() || undefined });
  const sendInput = (payload) => fetch('/api/input', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...authPayload(), ...payload })
  }).then((response) => {
    if (response.status === 401 || response.status === 410) location.reload();
    if (!response.ok) throw new Error(`Input failed (${response.status})`);
    return response;
  });
  const copySelection = async () => {
    const result = await api('/api/clipboard/read', { method: 'POST', body: JSON.stringify(authPayload()) });
    if (!result.text) throw new Error('Select text in the remote page first.');
    await navigator.clipboard.writeText(result.text);
    return result.text;
  };
  const pasteLocal = async () => {
    const text = await navigator.clipboard.readText();
    if (text) await sendInput({ type: 'text', text });
    return text;
  };

  if (!canControl) return { copySelection, pasteLocal };
  viewer.addEventListener('contextmenu', (event) => event.preventDefault());
  const point = (event) => {
    const rect = screen.getBoundingClientRect();
    const scaleX = (screen.naturalWidth || 1440) / rect.width;
    const scaleY = (screen.naturalHeight || 900) / rect.height;
    return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
  };
  viewer.addEventListener('pointerdown', (event) => {
    viewer.focus();
    viewer.setPointerCapture(event.pointerId);
    const p = point(event);
    sendInput({ type: 'mouse', event: 'mousePressed', ...p, button: ['left', 'middle', 'right'][event.button] || 'left', buttons: event.buttons, clickCount: event.detail || 1, modifiers: modifiers(event) });
    event.preventDefault();
  });
  viewer.addEventListener('pointerup', (event) => {
    const p = point(event);
    sendInput({ type: 'mouse', event: 'mouseReleased', ...p, button: ['left', 'middle', 'right'][event.button] || 'left', buttons: event.buttons, clickCount: event.detail || 1, modifiers: modifiers(event) });
    event.preventDefault();
  });
  viewer.addEventListener('pointermove', (event) => {
    const now = performance.now();
    if (moving || now - lastMove < 35) return;
    moving = true; lastMove = now;
    const p = point(event);
    sendInput({ type: 'mouse', event: 'mouseMoved', ...p, button: 'none', buttons: event.buttons, modifiers: modifiers(event) }).finally(() => { moving = false; });
  });
  viewer.addEventListener('wheel', (event) => {
    const p = point(event);
    sendInput({ type: 'wheel', ...p, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiers(event) });
    event.preventDefault();
  }, { passive: false });
  viewer.addEventListener('keydown', (event) => {
    const shortcut = (event.ctrlKey || event.metaKey) && !event.altKey ? event.key.toLowerCase() : '';
    if (shortcut === 'c') {
      copySelection().catch((error) => alert(error.message));
      event.preventDefault();
      return;
    }
    if (shortcut === 'v') {
      pasteLocal().catch((error) => alert(`Clipboard access failed: ${error.message}`));
      event.preventDefault();
      return;
    }
    const special = new Set(['Enter','Backspace','Tab','Escape','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','F5']);
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      sendInput({ type: 'text', text: event.key });
    } else if (special.has(event.key) || event.ctrlKey || event.altKey || event.metaKey) {
      sendInput({ type: 'key', event: 'keyDown', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiers(event), repeat: event.repeat });
      sendInput({ type: 'key', event: 'keyUp', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiers(event) });
    } else return;
    event.preventDefault();
  });
  window.addEventListener('beforeunload', () => { stopped = true; });
  return { copySelection, pasteLocal };
}

if (page === 'owner') {
  let currentBrowserSession = '';
  let latestSessions = [];
  const viewerControls = startViewer(true, () => currentBrowserSession);
  const address = document.querySelector('#address');
  const sessionSelect = document.querySelector('#browser-session');
  const shareTarget = document.querySelector('#share-target');
  const githubRepositoryField = document.querySelector('#github-repository-field');
  const syncShareTarget = () => { githubRepositoryField.hidden = shareTarget.value !== 'github'; };
  shareTarget.addEventListener('change', syncShareTarget);
  syncShareTarget();
  document.querySelector('#go').addEventListener('click', () => browserAction('navigate', address.value));
  address.addEventListener('keydown', (event) => { if (event.key === 'Enter') browserAction('navigate', address.value); });
  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => browserAction(button.dataset.nav)));
  document.querySelector('#logout').addEventListener('click', async () => { await api('/api/owner/logout', { method: 'POST', body: '{}' }); location.href = '/'; });
  document.querySelector('#copy-remote').addEventListener('click', () => viewerControls.copySelection().catch((error) => alert(error.message)));
  document.querySelector('#paste-remote').addEventListener('click', () => viewerControls.pasteLocal().catch((error) => alert(`Clipboard access failed: ${error.message}`)));
  async function browserAction(action, value) {
    try { await api('/api/browser/action', { method: 'POST', body: JSON.stringify({ action, value, browserSession: currentBrowserSession }) }); } catch (error) { alert(error.message); }
  }
  sessionSelect.addEventListener('change', () => {
    currentBrowserSession = sessionSelect.value;
    const selected = latestSessions.find((item) => item.id === currentBrowserSession);
    if (selected?.browserUrl) address.value = selected.browserUrl;
  });
  document.querySelector('#new-browser-session').addEventListener('click', async () => {
    const name = prompt('Name for the new browser session');
    if (!name) return;
    const initialUrl = prompt('Initial HTTPS website', 'https://www.facebook.com/');
    if (!initialUrl) return;
    try {
      const created = await api('/api/browser-sessions', { method: 'POST', body: JSON.stringify({ name, initialUrl }) });
      currentBrowserSession = created.id;
      await refreshStatus();
    } catch (error) { alert(error.message); }
  });
  document.querySelector('#delete-browser-session').addEventListener('click', async () => {
    const selected = latestSessions.find((item) => item.id === currentBrowserSession);
    if (!selected || selected.id === 'default') return alert('The Default browser session cannot be deleted.');
    if (!confirm(`Delete browser session "${selected.name}"? Its saved profile will be retained on the server.`)) return;
    try {
      await api(`/api/browser-sessions/${encodeURIComponent(selected.id)}`, { method: 'DELETE', body: '{}' });
      currentBrowserSession = 'default';
      await refreshStatus();
    } catch (error) { alert(error.message); }
  });
  document.querySelector('#create-share').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    data.browserSession = currentBrowserSession;
    try {
      const result = await api('/api/shares', { method: 'POST', body: JSON.stringify(data) });
      const safeUrl = escapeHtml(result.url);
      document.querySelector('#share-result').innerHTML = `<div class="result"><strong>Share URL</strong><br><a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a><br><button id="copy-link">Copy link</button></div>`;
      document.querySelector('#copy-link').addEventListener('click', () => navigator.clipboard.writeText(result.url));
      event.target.reset(); event.target.elements.minutes.value = 30;
      syncShareTarget();
      refreshStatus();
    } catch (error) { alert(error.message); }
  });
  async function refreshStatus() {
    try {
      const status = await api('/api/status');
      const githubOption = shareTarget.querySelector('option[value="github"]');
      githubOption.disabled = !status.githubConfigured;
      githubOption.textContent = status.githubConfigured ? 'GitHub API' : 'GitHub API (not configured)';
      if (!status.githubConfigured && shareTarget.value === 'github') { shareTarget.value = 'browser'; syncShareTarget(); }
      if (!status.browserEnabled && status.githubConfigured && !shareTarget.dataset.initialized) { shareTarget.value = 'github'; syncShareTarget(); }
      shareTarget.dataset.initialized = '1';
      latestSessions = status.sessions || [];
      if (!currentBrowserSession || !latestSessions.some((item) => item.id === currentBrowserSession)) currentBrowserSession = latestSessions[0]?.id || '';
      const optionSignature = latestSessions.map((item) => `${item.id}:${item.name}`).join('|');
      if (sessionSelect.dataset.signature !== optionSignature) {
        sessionSelect.innerHTML = latestSessions.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.connected ? '' : ' (offline)'}</option>`).join('');
        sessionSelect.dataset.signature = optionSignature;
      }
      sessionSelect.value = currentBrowserSession;
      const selected = latestSessions.find((item) => item.id === currentBrowserSession);
      if (selected?.browserUrl && document.activeElement !== address) address.value = selected.browserUrl;
      document.querySelector('#connection').textContent = !status.browserEnabled ? 'API-only mode' : selected?.connected ? `${selected.name} connected` : 'Browser unavailable';
      document.querySelector('#session-count').textContent = `${latestSessions.length}/${status.maxBrowserSessions} sessions`;
      document.querySelector('#new-browser-session').disabled = !status.browserEnabled;
      document.querySelector('#delete-browser-session').disabled = !status.browserEnabled || currentBrowserSession === 'default';
      document.querySelector('#shares').innerHTML = status.shares.length ? status.shares.map((share) => {
        const names = (share.guests || []).map((guest) => escapeHtml(guest.name)).join(', ');
        const people = `${share.guestCount || 0}/${status.maxGuestsPerLink} connected${names ? `: ${names}` : ''}`;
        return `<div class="share"><strong>${escapeHtml(share.targetName || share.browserSessionName)} · ${share.mode === 'view' ? 'View only' : 'Control'}</strong><small>${share.permanent ? 'Permanent until revoked' : `Expires ${new Date(share.expires).toLocaleString()}`} · ${people}</small><div class="share-actions"><button data-copy="${escapeHtml(share.url)}">Copy</button><button class="danger" data-revoke="${escapeHtml(share.id)}">Revoke</button></div></div>`;
      }).join('') : '<span class="hint">No active links</span>';
      document.querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => navigator.clipboard.writeText(b.dataset.copy));
      document.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => { await api(`/api/shares/${encodeURIComponent(b.dataset.revoke)}`, { method: 'DELETE', body: '{}' }); refreshStatus(); });
    } catch { document.querySelector('#connection').textContent = 'Disconnected'; }
  }
  refreshStatus(); setInterval(refreshStatus, 3000);
}

if (page === 'guest') {
  const viewerControls = startViewer(mode === 'control');
  let guestAddress = null;
  if (mode === 'control') {
    const address = document.querySelector('#guest-address');
    guestAddress = address;
    const browserAction = async (action, value) => {
      try { await api('/api/browser/action', { method: 'POST', body: JSON.stringify({ action, value, session: sessionId }) }); }
      catch (error) { alert(error.message); }
    };
    document.querySelector('#guest-go').addEventListener('click', () => browserAction('navigate', address.value));
    address.addEventListener('keydown', (event) => { if (event.key === 'Enter') browserAction('navigate', address.value); });
    document.querySelectorAll('[data-guest-nav]').forEach((button) => button.addEventListener('click', () => browserAction(button.dataset.guestNav)));
    document.querySelector('#copy-remote').addEventListener('click', () => viewerControls.copySelection().catch((error) => alert(error.message)));
    document.querySelector('#paste-remote').addEventListener('click', () => viewerControls.pasteLocal().catch((error) => alert(`Clipboard access failed: ${error.message}`)));
  }
  const refreshGuestStatus = async () => {
    try {
      const status = await api(`/api/s/${encodeURIComponent(sessionId)}/status`);
      if (guestAddress && document.activeElement !== guestAddress) guestAddress.value = status.browserUrl || '';
      const names = (status.guests || []).map((guest) => guest.name).join(', ');
      const role = mode === 'control' ? 'Controllers' : 'Viewers';
      document.querySelector('#guest-presence').textContent = `${role} ${status.guestCount}/${status.maxGuestsPerLink}${names ? `: ${names}` : ''}`;
    } catch {}
  };
  refreshGuestStatus();
  setInterval(refreshGuestStatus, 2500);
  document.querySelector('#guest-logout').addEventListener('click', async () => {
    await api(`/api/s/${encodeURIComponent(sessionId)}/logout`, { method: 'POST', body: '{}' }).catch(() => {});
    location.reload();
  });
}

if (page === 'github-guest') {
  const message = document.querySelector('#github-message');
  const issues = document.querySelector('#github-issues');
  const presence = document.querySelector('#guest-presence');

  async function refreshPresence() {
    try {
      const status = await api(`/api/s/${encodeURIComponent(sessionId)}/status`);
      const names = (status.guests || []).map((guest) => guest.name).join(', ');
      const role = mode === 'control' ? 'Editors' : 'Viewers';
      presence.textContent = `${role} ${status.guestCount}/${status.maxGuestsPerLink}${names ? `: ${names}` : ''}`;
    } catch {}
  }

  async function refreshGitHub() {
    message.textContent = '';
    try {
      const result = await api(`/api/s/${encodeURIComponent(sessionId)}/github/overview`);
      document.querySelector('#github-repository').textContent = result.repository.fullName;
      document.querySelector('#github-description').textContent = result.repository.description || `${result.repository.private ? 'Private' : 'Public'} repository`;
      issues.innerHTML = result.issues.length ? result.issues.map((issue) => `<article class="share">
        <strong>${issue.pullRequest ? 'Pull request' : 'Issue'} #${issue.number}: ${escapeHtml(issue.title)}</strong>
        <small>By ${escapeHtml(issue.author)} · ${issue.comments} comments · updated ${new Date(issue.updatedAt).toLocaleString()}</small>
        ${issue.body ? `<p>${escapeHtml(issue.body.slice(0, 1200))}</p>` : ''}
        <div class="share-actions"><button data-open-github="${escapeHtml(issue.htmlUrl)}" class="subtle">Open on GitHub</button>${mode === 'control' ? `<button data-comment="${issue.number}">Comment</button>` : ''}</div>
      </article>`).join('') : '<span class="hint">No open issues or pull requests</span>';
      document.querySelectorAll('[data-open-github]').forEach((button) => button.onclick = () => window.open(button.dataset.openGithub, '_blank', 'noopener'));
      document.querySelectorAll('[data-comment]').forEach((button) => button.onclick = async () => {
        const body = prompt(`Comment on #${button.dataset.comment}`);
        if (!body) return;
        try {
          await api(`/api/s/${encodeURIComponent(sessionId)}/github/issues/${encodeURIComponent(button.dataset.comment)}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
          await refreshGitHub();
        } catch (error) { alert(error.message); }
      });
    } catch (error) {
      message.textContent = error.message;
      issues.innerHTML = '';
    }
  }

  const createIssue = document.querySelector('#github-create-issue');
  if (createIssue) createIssue.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api(`/api/s/${encodeURIComponent(sessionId)}/github/issues`, { method: 'POST', body: JSON.stringify({ title: form.get('title'), body: form.get('body') }) });
      event.target.reset();
      await refreshGitHub();
    } catch (error) { alert(error.message); }
  });

  document.querySelector('#github-refresh').addEventListener('click', refreshGitHub);
  document.querySelector('#guest-logout').addEventListener('click', async () => {
    await api(`/api/s/${encodeURIComponent(sessionId)}/logout`, { method: 'POST', body: '{}' }).catch(() => {});
    location.reload();
  });
  refreshPresence();
  refreshGitHub();
  setInterval(refreshPresence, 2500);
}
