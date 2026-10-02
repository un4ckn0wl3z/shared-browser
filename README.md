# Session Share Server

Cross-platform MVP for sharing server-side Chromium sessions through password-protected URLs. Each session has an independent persistent browser profile and can open any HTTPS website selected by the owner. The guest receives JPEG frames and sends mouse/keyboard events to Chromium; browser profiles and login cookies remain on the host.

> This tool grants another person the ability to act as the logged-in account. Use it only with accounts and users you are authorized to manage. For Facebook Pages, native Page/task access is safer than sharing a personal session.

## Requirements

- Node.js 22 or newer
- Chrome, Edge, or Chromium
- HTTPS reverse proxy or tunnel before exposing it to the internet

No `npm install` is required.

## Run without installing Chrome

If Node.js 22+, `wget`, and `unzip` already exist but you cannot install system packages, use the rootless portable launcher:

```bash
git clone https://github.com/un4ckn0wl3z/shared-browser.git
cd shared-browser
chmod +x download-chrome.sh start-portable.sh
OWNER_PASSWORD='use-a-long-random-password' ./start-portable.sh
```

The launcher resolves the current Stable Chrome for Testing build from Google's official JSON API, downloads it with `wget`, and stores it under `.runtime/`. Later runs reuse that copy. Force a fresh download with:

```bash
./download-chrome.sh --force
```

This does not require root and does not modify system directories. Chrome is not fully static, however: the host must already provide its Linux shared-library dependencies. If it fails to start, inspect missing libraries with:

```bash
ldd .runtime/chrome-linux64/chrome | grep 'not found'
```

On ARM64, the directory is `.runtime/chrome-linux-arm64/`. If required libraries are missing and you have no package-install privileges, the practical options are asking the host administrator to provide them or running on a less minimal Linux host.

## Run on Windows

```powershell
$env:OWNER_PASSWORD = 'use-a-long-random-password'
.\start.ps1
```

The program detects Chrome/Edge automatically. To select one explicitly:

```powershell
$env:CHROME_BIN = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
.\start.ps1
```

## Run directly on Linux

Install Node.js and Chromium using the distribution package manager, then:

```bash
chmod +x start.sh
OWNER_PASSWORD='use-a-long-random-password' ./start.sh
```

On a Linux server without a graphical desktop, set `HEADLESS=1`:

```bash
HEADLESS=1 OWNER_PASSWORD='use-a-long-random-password' ./start.sh
```

## Run with Docker on Linux

First change `OWNER_PASSWORD` in `docker-compose.yml`, then:

```bash
docker compose up --build -d
docker compose logs -f
```

Open `http://127.0.0.1:17890` on the server or publish it through an HTTPS reverse proxy/tunnel. Browser state is persisted under `./data`.

## Make it accessible by URL

The server listens on `127.0.0.1:17890` by default. Put it behind Caddy, Nginx, or a tunnel. For a temporary development URL:

```bash
cloudflared tunnel --url http://127.0.0.1:17890
```

Open the generated HTTPS URL as the owner, log into the browser shown in the page, and create a guest link. Quick tunnels are intended for testing; use a named tunnel or your own HTTPS domain for production.

Example Caddy configuration:

```caddyfile
remote.example.com {
    reverse_proxy 127.0.0.1:17890
}
```

If connecting directly to a Linux host behind an existing TLS proxy:

```bash
HOST=0.0.0.0 PORT=17890 OWNER_PASSWORD='...' ./start.sh
```

Do not expose plain HTTP to the public internet.

## Usage

1. Start the server and open the owner console.
2. Enter the owner password printed by the process, or supplied through `OWNER_PASSWORD`.
3. Use the Default streamed browser, or click **New session** to create another independent browser profile.
4. Open any HTTPS website and log in. Domains explicitly opened by the owner are allowed for that session's guests.
5. Enter a guest password, expiration, and `Control` or `View only` mode.
6. Send the generated link and password separately.
7. Revoke the link when finished.

Only one guest may use a particular link at a time. A disconnected guest slot is released after 30 seconds.

Control-mode guests have an address bar and may navigate to any HTTPS website. They can use **Paste** or Ctrl/Cmd+V to insert text from their local clipboard into the focused remote field. After selecting text in the remote page, **Copy selection** or Ctrl/Cmd+C copies it to their local clipboard. Clipboard APIs require localhost or a public HTTPS URL; plain public HTTP will normally be rejected by the guest browser.

Deleting a browser session stops its Chromium process and revokes its share links, but intentionally retains its profile directory under `data/browser-profiles/` for manual recovery. The Default session cannot be deleted.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OWNER_PASSWORD` | Random at startup | Owner-console password |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `PORT` | `17890` | HTTP port |
| `PUBLIC_URL` | Derived from request | Canonical external URL, e.g. `https://remote.example.com` |
| `TRUST_PROXY` | `0` | Set to `1` only behind a trusted proxy to rate-limit by forwarded client IP |
| `CHROME_BIN` | Auto-detected | Absolute Chrome/Chromium executable |
| `CHROME_DEBUG_PORT` | `19222` | Local DevTools port |
| `MAX_BROWSER_SESSIONS` | `5` | Maximum independent Chromium sessions (hard limit 20) |
| `INITIAL_URL` | Facebook | Initial browser page |
| `DATA_DIR` | `./data` | Persistent profile directory |
| `HEADLESS` | `0` | Set to `1` on a headless Linux server |
| `CHROME_NO_SANDBOX` | `0` | Set to `1` only inside a suitably isolated container |
| `ALLOWED_HOSTS` | Meta domains | Additional top-level hosts allowed for every guest; owner-opened domains are added to that browser session automatically; use `*` to allow all HTTPS domains |
| `STREAM_WIDTH` | `1440` | Maximum stream width |
| `STREAM_HEIGHT` | `900` | Maximum stream height |
| `STREAM_QUALITY` | `72` | JPEG quality, 1–100 |

## Security notes

- DevTools binds only to `127.0.0.1`; never publish its port.
- Guest passwords use scrypt with a random salt and are held only in memory.
- Owner and guest password attempts are rate-limited per source address.
- Guest and owner cookies are `HttpOnly` and `SameSite=Strict`; `Secure` is added when the reverse proxy sends `X-Forwarded-Proto: https`.
- Downloads are denied. Control-mode guests may open any HTTPS URL; `ALLOWED_HOSTS` provides domains that are pre-authorized before an owner or guest explicitly navigates to them.
- Share links disappear on server restart, while the Chromium login profile persists.
- This MVP streams JPEG images over repeated HTTP requests. For many concurrent users or video-heavy pages, replace the frame transport with WebRTC and operate a TURN service.
- Protect the host and the `data` directory. Anyone who obtains the browser profile may be able to access the logged-in account.
