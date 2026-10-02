function shell(title, page, body, extra = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/static/style.css"></head>
<body data-page="${page}" ${extra}>${body}<script src="/static/client.js" defer></script></body></html>`;
}

export function ownerLoginPage() {
  return shell('Session Share — Owner', 'owner-login', `
  <main class="card narrow"><h1>Session Share</h1><p>Enter the owner password printed by the server.</p>
  <form id="owner-login"><label>Owner password<input name="password" type="password" autocomplete="current-password" required autofocus></label>
  <button>Open owner console</button><p id="message" class="message"></p></form></main>`);
}

export function ownerPage() {
  return shell('Session Share — Console', 'owner', `
  <header><strong>Session Share</strong><span id="connection">Connecting…</span><button id="logout" class="subtle">Log out</button></header>
  <section class="sessionbar"><label>Browser session<select id="browser-session"></select></label><button id="new-browser-session">＋ New session</button><button id="delete-browser-session" class="danger">Delete</button><span id="session-count"></span></section>
  <section class="toolbar">
    <button data-nav="back" title="Back">←</button><button data-nav="forward" title="Forward">→</button><button data-nav="reload" title="Reload">↻</button>
    <input id="address" value="https://www.facebook.com/" aria-label="Address"><button id="go">Go</button><button id="copy-remote" class="subtle">Copy selection</button><button id="paste-remote" class="subtle">Paste</button>
  </section>
  <main class="layout"><section><div id="viewer" class="viewer" tabindex="0"><img id="screen" alt="Remote browser"><div id="viewer-status">Waiting for Chromium…</div></div></section>
  <aside><h2>Create share link</h2><form id="create-share">
    <label>Target<select name="targetType" id="share-target"><option value="browser">Browser session</option><option value="github">GitHub API</option></select></label>
    <label id="github-repository-field" hidden>GitHub repository<input name="repository" placeholder="owner/repository"></label>
    <label>Guest password<input name="password" type="password" minlength="6" required></label>
    <label>Expires after<input name="minutes" type="number" value="30" min="1" max="1440" required><span>minutes</span></label>
    <label><span><input name="permanent" type="checkbox"> Permanent — valid until revoked</span></label>
    <label>Mode<select name="mode"><option value="control">Control</option><option value="view">View only</option></select></label>
    <button>Create link</button></form><div id="share-result"></div>
    <h2>Active links</h2><div id="shares" class="shares"></div><p class="hint">Multiple guests can share one link. Everyone on a Control link can send input; the latest input wins. Press Revoke to disconnect everyone.</p></aside></main>`);
}

export function guestLoginPage(sessionId, mode, targetType = 'browser', repository = '') {
  const target = targetType === 'github' ? `GitHub repository <strong>${repository}</strong>` : 'a browser session';
  return shell('Session Share — Sign in', 'guest-login', `
  <main class="card narrow"><h1>Shared session</h1><p>This link grants <strong>${mode === 'view' ? 'view-only' : 'control'}</strong> access to ${target}.</p>
  <form id="guest-login"><label>Your display name<input name="name" maxlength="40" autocomplete="nickname" required autofocus></label>
  <label>Access password<input name="password" type="password" autocomplete="current-password" required></label>
  <button>Connect</button><p id="message" class="message"></p></form></main>`, `data-session-id="${sessionId}"`);
}

export function githubGuestPage(sessionId, mode, repository) {
  const createIssue = mode === 'control' ? `<section class="github-create"><h2>Create issue</h2><form id="github-create-issue">
    <label>Title<input name="title" maxlength="256" required></label>
    <label>Description<textarea name="body" rows="5"></textarea></label>
    <button>Create issue</button></form></section>` : '';
  return shell('Session Share — GitHub', 'github-guest', `
  <header><strong>GitHub API · ${repository}</strong><span id="guest-presence">Connecting…</span><button id="guest-logout" class="subtle">Disconnect</button></header>
  <main class="github-main"><section><h1 id="github-repository">${repository}</h1><p id="github-description" class="hint">Loading repository…</p><button id="github-refresh" class="subtle">Refresh</button></section>
  ${createIssue}<section><h2>Open issues and pull requests</h2><div id="github-message" class="message"></div><div id="github-issues" class="shares"></div></section></main>`,
  `data-session-id="${sessionId}" data-mode="${mode}"`);
}

export function guestPage(sessionId, mode) {
  const controls = mode === 'control' ? `<section class="toolbar">
    <button data-guest-nav="back" title="Back">←</button><button data-guest-nav="forward" title="Forward">→</button><button data-guest-nav="reload" title="Reload">↻</button>
    <input id="guest-address" value="" placeholder="https://example.com/" aria-label="Address"><button id="guest-go">Go</button><button id="copy-remote" class="subtle">Copy selection</button><button id="paste-remote" class="subtle">Paste</button>
  </section>` : '';
  return shell('Session Share — Browser', 'guest', `
  <header><strong>Shared browser</strong><span id="guest-presence">${mode === 'view' ? 'View only' : 'Control enabled'} · connecting…</span><button id="guest-logout" class="subtle">Disconnect</button></header>
  ${controls}
  <main class="guest-main"><div id="viewer" class="viewer" tabindex="0"><img id="screen" alt="Remote browser"><div id="viewer-status">Connecting…</div></div>
  <p class="hint">Everything you do is performed in the browser running on the host server.</p></main>`, `data-session-id="${sessionId}" data-mode="${mode}"`);
}
