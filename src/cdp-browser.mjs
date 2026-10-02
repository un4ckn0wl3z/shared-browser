import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findInPath(names) {
  const pathEntries = (process.env.PATH || '').split(delimiter);
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = join(entry, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function findChrome() {
  if (process.env.CHROME_BIN) {
    if (!existsSync(process.env.CHROME_BIN)) {
      throw new Error(`CHROME_BIN does not exist: ${process.env.CHROME_BIN}`);
    }
    return process.env.CHROME_BIN;
  }

  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const suffixes = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Chromium', 'Application', 'chrome.exe']
    ];
    for (const root of roots) {
      for (const parts of suffixes) {
        const candidate = join(root, ...parts);
        if (existsSync(candidate)) return candidate;
      }
    }
    return findInPath(['chrome.exe', 'msedge.exe', 'chromium.exe']);
  }

  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ];
    return candidates.find(existsSync) || null;
  }

  return findInPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']);
}

export class CdpBrowser {
  constructor({ executable, profileDir, debuggingPort, initialUrl, headless = false }) {
    this.executable = executable;
    this.profileDir = profileDir;
    this.debuggingPort = debuggingPort;
    this.initialUrl = initialUrl;
    this.headless = headless;
    this.process = null;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.frame = null;
    this.frameRevision = 0;
    this.currentUrl = initialUrl;
    this.lastAllowedUrl = initialUrl;
    this.onUrl = null;
  }

  async start() {
    const args = [
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${this.debuggingPort}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--disable-session-crashed-bubble',
      '--window-size=1440,900'
    ];
    if (this.headless) args.push('--headless=new', '--disable-gpu');
    if (process.env.CHROME_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-dev-shm-usage');
    args.push(this.initialUrl);

    this.process = spawn(this.executable, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: false
    });
    this.process.stderr.on('data', (chunk) => {
      const line = chunk.toString();
      if (/ERROR|FATAL/i.test(line) && process.env.DEBUG_BROWSER === '1') process.stderr.write(line);
    });

    let version;
    let lastError;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (this.process.exitCode !== null) throw new Error(`Chromium exited with code ${this.process.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${this.debuggingPort}/json/list`);
        if (response.ok) {
          const targets = await response.json();
          version = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
          if (version) break;
        }
      } catch (error) {
        lastError = error;
      }
      await delay(250);
    }
    if (!version) throw new Error(`Could not connect to Chromium DevTools: ${lastError?.message || 'no page target'}`);

    await this.connect(version.webSocketDebuggerUrl);
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Page.bringToFront');
    await this.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    await this.send('Page.startScreencast', {
      format: 'jpeg',
      quality: Number(process.env.STREAM_QUALITY || 72),
      maxWidth: Number(process.env.STREAM_WIDTH || 1440),
      maxHeight: Number(process.env.STREAM_HEIGHT || 900),
      everyNthFrame: 1
    });
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
      this.socket.addEventListener('close', () => {
        for (const { reject: rejectPending } of this.pending.values()) rejectPending(new Error('Chromium DevTools disconnected'));
        this.pending.clear();
      });
    });
  }

  handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === 'Page.screencastFrame') {
      this.frame = Buffer.from(message.params.data, 'base64');
      this.frameRevision += 1;
      this.send('Page.screencastFrameAck', { sessionId: message.params.sessionId }).catch(() => {});
    }
    if (message.method === 'Page.frameNavigated' && message.params.frame?.parentId === undefined) {
      this.currentUrl = message.params.frame.url;
      if (typeof this.onUrl === 'function') this.onUrl(this.currentUrl);
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return reject(new Error('Chromium is not connected'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.reject(new Error(`CDP timeout: ${method}`));
        }
      }, 10000).unref();
    });
  }

  async input(action) {
    switch (action.type) {
      case 'mouse':
        return this.send('Input.dispatchMouseEvent', {
          type: action.event,
          x: Number(action.x) || 0,
          y: Number(action.y) || 0,
          button: action.button || 'none',
          buttons: Number(action.buttons) || 0,
          clickCount: Number(action.clickCount) || 0,
          modifiers: Number(action.modifiers) || 0
        });
      case 'wheel':
        return this.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Number(action.x) || 0,
          y: Number(action.y) || 0,
          deltaX: Number(action.deltaX) || 0,
          deltaY: Number(action.deltaY) || 0,
          modifiers: Number(action.modifiers) || 0
        });
      case 'text':
        return this.send('Input.insertText', { text: String(action.text || '').slice(0, 65536) });
      case 'key':
        return this.send('Input.dispatchKeyEvent', {
          type: action.event,
          key: String(action.key || ''),
          code: String(action.code || ''),
          text: action.text ? String(action.text) : undefined,
          windowsVirtualKeyCode: Number(action.keyCode) || 0,
          nativeVirtualKeyCode: Number(action.keyCode) || 0,
          modifiers: Number(action.modifiers) || 0,
          autoRepeat: Boolean(action.repeat)
        });
      default:
        throw new Error('Unsupported input action');
    }
  }

  async browserAction(action, value) {
    if (action === 'navigate') return this.send('Page.navigate', { url: String(value) });
    if (action === 'back') return this.send('Runtime.evaluate', { expression: 'history.back()' });
    if (action === 'forward') return this.send('Runtime.evaluate', { expression: 'history.forward()' });
    if (action === 'reload') return this.send('Page.reload', { ignoreCache: false });
    throw new Error('Unsupported browser action');
  }

  async selectedText() {
    const expression = `(() => {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') &&
          typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number') {
        return active.value.slice(active.selectionStart, active.selectionEnd);
      }
      return window.getSelection ? window.getSelection().toString() : '';
    })()`;
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return String(result?.result?.value || '').slice(0, 65536);
  }

  async stop() {
    try { await this.send('Browser.close'); } catch {}
    if (this.process && this.process.exitCode === null) this.process.kill();
  }
}
