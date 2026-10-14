import { app, BrowserWindow, Menu, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import { ensureEnvironmentPaths } from '../src/config.js';

// Enforce app identity across dev and packaged modes
app.name = 'Plaud Studio';
app.setName('Plaud Studio');
if (process.title) {
  process.title = 'Plaud Studio';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const iconPath = path.join(__dirname, '../assets/icon.png');

// Ensure path variables are loaded
ensureEnvironmentPaths();

let mainWindow = null;
let serverInstance = null;
let serverPort = 3300;

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    title: 'Plaud Studio',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0f172a',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(`http://localhost:${port}`);
  mainWindow.show();
  mainWindow.focus();

  if (process.platform === 'darwin') {
    if (fs.existsSync(iconPath)) {
      try {
        app.dock?.setIcon(iconPath);
      } catch (_) {}
    }
    app.dock?.show();
  }

  // Enforce consistent title
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    mainWindow.setTitle('Plaud Studio');
  });

  // Open external links in default browser instead of Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      if (!url.includes(`localhost:${port}`)) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupDevWatchers() {
  if (app.isPackaged) return;

  const publicDir = path.join(__dirname, '..', 'public');
  const srcDir = path.join(__dirname, '..', 'src');

  // 1. Hot-reload frontend UI when files in public/ change
  if (fs.existsSync(publicDir)) {
    let reloadTimer = null;
    fs.watch(publicDir, { recursive: true }, (event, filename) => {
      if (filename && /\.(html|css|js)$/.test(filename)) {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            console.log(`[Dev Auto-Reload] UI updated (${filename}), reloading window...`);
            mainWindow.webContents.reloadIgnoringCache();
          }
        }, 120);
      }
    });
  }

  // 2. Auto-relaunch Electron app when backend code in src/ or electron/ changes
  const watchDirs = [srcDir, __dirname];
  let restartTimer = null;
  for (const dir of watchDirs) {
    if (fs.existsSync(dir)) {
      fs.watch(dir, { recursive: true }, (event, filename) => {
        if (filename && /\.(js|cjs|mjs)$/.test(filename)) {
          clearTimeout(restartTimer);
          restartTimer = setTimeout(() => {
            console.log(`[Dev Auto-Restart] Backend updated (${filename}), relaunching app...`);
            app.relaunch();
            app.exit(0);
          }, 250);
        }
      });
    }
  }
}

function createMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [
          {
            label: 'Plaud Studio',
            submenu: [
              { role: 'about', label: 'About Plaud Studio' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: 'Hide Plaud Studio' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: 'Quit Plaud Studio' }
            ]
          }
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'front' }, { type: 'separator' }, { role: 'window' }]
          : [{ role: 'close' }])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Open Plaud Web Console',
          click: async () => {
            await shell.openExternal('https://web.plaud.ai');
          }
        },
        {
          label: 'Google AI Studio (Gemini Keys)',
          click: async () => {
            await shell.openExternal('https://aistudio.google.com/app/apikey');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow(serverPort);
    }
  });

  app.whenReady().then(async () => {
    try {
      // Start express backend
      const result = await startServer(serverPort);
      serverInstance = result.server;
      serverPort = result.port;

      if (process.platform === 'darwin') {
        if (fs.existsSync(iconPath)) {
          try {
            app.dock?.setIcon(iconPath);
          } catch (_) {}
        }
        try {
          app.setAboutPanelOptions({
            applicationName: 'Plaud Studio',
            applicationVersion: '1.0.0',
            version: '1.0.0',
            copyright: 'Copyright © 2026 Plaud Studio',
            iconPath: fs.existsSync(iconPath) ? iconPath : undefined
          });
        } catch (_) {}
      }

      createMenu();
      await createWindow(serverPort);
      setupDevWatchers();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow(serverPort);
        } else if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      });
    } catch (err) {
      console.error('Failed to start Plaud Studio:', err);
      dialog.showErrorBox('Startup Error', `Failed to initialize application backend: ${err.message}`);
      app.quit();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverInstance) {
    try {
      serverInstance.close();
    } catch (_) {}
  }
});
