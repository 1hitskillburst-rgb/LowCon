const { app, BrowserWindow, dialog, nativeTheme, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startDesktopServer, unloadAllLocalModels } = require('./server.cjs');

const ALLOWED_ELECTRON_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

let mainWindow = null;
let embeddedServer = null;
let isUnloadingOnQuit = false;
let quitUnloadDone = false;

app.setAppUserModelId('com.lowcon.workbench');

function resolveWindowIcon() {
  const buildDir = path.join(__dirname, 'build');
  const candidates =
    process.platform === 'win32'
      ? [path.join(buildDir, 'icon.ico'), path.join(buildDir, 'icon.png')]
      : [path.join(buildDir, 'icon.png')];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildStartupErrorHtml(title, detail, hint) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #F7F8F9;
        color: #161B26;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
      }
      .card {
        max-width: 560px;
        background: #FFFFFF;
        border: 1px solid #D8DEE6;
        border-radius: 12px;
        padding: 28px;
        box-shadow: 0 8px 24px rgba(22, 27, 38, 0.08);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 20px;
      }
      p {
        margin: 0 0 12px;
        line-height: 1.5;
        color: #424B5C;
      }
      pre {
        margin: 12px 0 0;
        padding: 12px;
        background: #F1F3F6;
        border-radius: 8px;
        overflow-x: auto;
        font-size: 12px;
        color: #161B26;
      }
      @media (prefers-color-scheme: dark) {
        body {
          background: #11141A;
          color: #F3F6FA;
        }
        .card {
          background: #181C24;
          border-color: #2B3240;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        }
        p {
          color: #C2CAD8;
        }
        pre {
          background: #141820;
          color: #E2E8F0;
        }
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(hint)}</p>
      <pre>${escapeHtml(detail)}</pre>
    </div>
  </body>
</html>`;
}

function isDevMode() {
  return process.env.LOWCON_DESKTOP_DEV === '1' || process.argv.includes('--dev');
}

async function showErrorPage(win, title, detail, hint) {
  const html = buildStartupErrorHtml(title, detail, hint);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function createMainWindow() {
  const isDev = isDevMode();
  let appUrl = 'http://127.0.0.1:3000';
  let startupError = null;

  if (!isDev) {
    try {
      const distDir = path.join(__dirname, '..', 'dist');
      const started = await startDesktopServer(distDir);
      embeddedServer = started.server;
      appUrl = started.url;
    } catch (err) {
      startupError = err instanceof Error ? err.message : String(err);
    }
  }

  const allowedOrigin = new URL(appUrl).origin;
  const iconPath = resolveWindowIcon();

  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    title: 'LowCon — Local Model Workbench',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#11141A' : '#F7F8F9',
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Block untrusted external navigations inside the desktop window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        void shell.openExternal(url);
      }
    } catch {
      // Ignore malformed URLs
    }
    return { action: 'deny' };
  });

  // Prevent file:// drops (e.g. .gguf files) or off-origin links from navigating away
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol === 'file:' || parsed.origin !== allowedOrigin) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (startupError) {
    console.error('[LowCon Desktop] Failed to start embedded server:', startupError);
    await showErrorPage(
      mainWindow,
      'LowCon Desktop Startup Failed',
      startupError,
      'Build the frontend bundle with "npm run build" before launching the desktop app.',
    );
    return;
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // -3 is ERR_ABORTED (normal cancellation)
    if (errorCode === -3 || !mainWindow || validatedURL.startsWith('data:')) return;
    const hint = isDev
      ? 'Make sure the LowCon dev server is running on http://127.0.0.1:3000 ("npm run dev").'
      : 'Ensure the built assets in dist/ are intact and restart LowCon.';
    void showErrorPage(
      mainWindow,
      'LowCon Could Not Load',
      `${errorDescription} (code ${errorCode}) at ${validatedURL}`,
      hint,
    );
  });

  try {
    await mainWindow.loadURL(appUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[LowCon Desktop] Failed to load URL:', msg);
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Defense-in-depth egress guard: block any non-loopback network request from the desktop renderer
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const parsed = new URL(details.url);
        if (
          parsed.protocol === 'http:' ||
          parsed.protocol === 'https:' ||
          parsed.protocol === 'ws:' ||
          parsed.protocol === 'wss:'
        ) {
          const allowed = ALLOWED_ELECTRON_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
          callback({ cancel: !allowed });
          return;
        }
      } catch {
        callback({ cancel: true });
        return;
      }
      callback({ cancel: false });
    });

    createMainWindow().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[LowCon Desktop] Fatal startup error:', msg);
      dialog.showErrorBox('LowCon Startup Error', msg);
      app.quit();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  });
}

function closeEmbeddedServer() {
  if (embeddedServer) {
    embeddedServer.close();
    if (typeof embeddedServer.closeAllConnections === 'function') {
      embeddedServer.closeAllConnections();
    }
    embeddedServer = null;
  }
}

app.on('before-quit', (event) => {
  if (quitUnloadDone) {
    closeEmbeddedServer();
    return;
  }
  event.preventDefault();
  if (isUnloadingOnQuit) return;
  isUnloadingOnQuit = true;

  const timeout = new Promise((resolve) => setTimeout(resolve, 4500));
  Promise.race([unloadAllLocalModels().catch(() => {}), timeout]).finally(() => {
    quitUnloadDone = true;
    closeEmbeddedServer();
    app.quit();
  });
});

app.on('will-quit', closeEmbeddedServer);

app.on('window-all-closed', () => {
  closeEmbeddedServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
