const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { startDesktopServer } = require('./server.cjs');

let mainWindow = null;
let embeddedServer = null;

async function createMainWindow() {
  const isDev = process.env.LOWCON_DESKTOP_DEV === '1';
  let appUrl = 'http://127.0.0.1:3000';

  if (!isDev) {
    const distDir = path.join(__dirname, '..', 'dist');
    const started = await startDesktopServer(distDir);
    embeddedServer = started.server;
    appUrl = started.url;
  }

  const allowedOrigin = new URL(appUrl).origin;

  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    title: 'LowCon — Local Model Workbench',
    backgroundColor: '#F7F8F9',
    autoHideMenuBar: true,
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

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      if (new URL(targetUrl).origin !== allowedOrigin) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  await mainWindow.loadURL(appUrl);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  void createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (embeddedServer) {
    embeddedServer.close();
    embeddedServer = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
