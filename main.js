// Cookup - Electron main process
// Spawns the local Python MusicGen server, manages the window, handles
// file dialogs and the drag-out-to-DAW flow.

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

const Store = require('electron-store');
const store = new Store({
  defaults: {
    outputDir: path.join(os.homedir(), 'Music', 'Cookup'),
    pythonPath: '',
    serverPort: 7781
  }
});

const { generateBeat, checkHealth, warmup } = require('./src/generator');

let mainWindow;
let pyProc = null;

const IS_WIN = process.platform === 'win32';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 820,
    minWidth: 440,
    minHeight: 680,
    backgroundColor: '#0e0e10',
    icon: path.join(__dirname, 'build', IS_WIN ? 'icon.ico' : 'icon.png'),
    // vibrancy / hidden inset title bar are mac-only; harmless on Windows
    titleBarStyle: IS_WIN ? 'default' : 'hiddenInset',
    vibrancy: IS_WIN ? undefined : 'under-window',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  try { fs.mkdirSync(store.get('outputDir'), { recursive: true }); } catch (_) {}
}

// ---------- Python server lifecycle ----------

function pythonBinaryIn(base) {
  // On Unix: base/bin/python3. On Windows: base\python.exe.
  return IS_WIN
    ? path.join(base, 'python.exe')
    : path.join(base, 'bin', 'python3');
}

function resolvePython() {
  // 1. Explicit override in settings wins.
  const custom = store.get('pythonPath');
  if (custom && fs.existsSync(custom)) return custom;

  // 2. In a packaged app, use the bundled portable Python under Resources.
  if (app.isPackaged) {
    const bundled = pythonBinaryIn(path.join(process.resourcesPath, 'python-runtime'));
    if (fs.existsSync(bundled)) return bundled;
  }

  // 3. In dev, prefer a co-located bundled runtime, then a venv.
  const devBundled = pythonBinaryIn(path.join(__dirname, 'python-runtime'));
  if (fs.existsSync(devBundled)) return devBundled;
  const venvPy = pythonBinaryIn(path.join(__dirname, IS_WIN ? '.venv\\Scripts' : '.venv'));
  if (fs.existsSync(venvPy)) return venvPy;

  // 4. Last resort: hope the system has Python on PATH.
  return IS_WIN ? 'python.exe' : 'python3';
}

function resolveServerScript() {
  if (app.isPackaged) {
    const unpacked = path.join(
      process.resourcesPath, 'app.asar.unpacked', 'src', 'musicgen_server.py'
    );
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return path.join(__dirname, 'src', 'musicgen_server.py');
}

function startPythonServer() {
  const py = resolvePython();
  const script = resolveServerScript();
  const port = store.get('serverPort');

  const env = {
    ...process.env,
    COOKUP_PORT: String(port),
    COOKUP_HOST: '127.0.0.1'
  };

  // windowsHide: keeps the Python subprocess console from popping up on Windows.
  // -u forces unbuffered stdout/stderr so MusicGen's tqdm progress lines
  // stream to us in real time instead of all arriving at the end.
  // windowsHide: keeps the Python subprocess console from popping up on Windows.
  pyProc = spawn(py, ['-u', script], { env, shell: false, windowsHide: true, detached: false });

  pyProc.stdout.on('data', (buf) => {
    const s = buf.toString();
    process.stdout.write('[py] ' + s);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('py:log', s);
  });
  pyProc.stderr.on('data', (buf) => {
    const s = buf.toString();
    process.stderr.write('[py!] ' + s);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('py:log', s);
  });
  pyProc.on('exit', (code) => {
    console.log('[py] exited with code', code);
    pyProc = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('py:exit', code);
  });
}

function stopPythonServer() {
  if (pyProc && !pyProc.killed) {
    try { pyProc.kill(); } catch (_) {}
    pyProc = null;
  }
}

app.whenReady().then(() => {
  createWindow();
  startPythonServer();
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => log.warn('Update check failed', err));
  }
});
app.on('window-all-closed', () => {
  stopPythonServer();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', stopPythonServer);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------- Auto-updater ----------

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

autoUpdater.on('checking-for-update', () => sendToRenderer('updater:status', { state: 'checking' }));
autoUpdater.on('update-available', (info) => sendToRenderer('updater:status', { state: 'available', version: info && info.version }));
autoUpdater.on('update-not-available', () => sendToRenderer('updater:status', { state: 'none' }));
autoUpdater.on('error', (err) => sendToRenderer('updater:status', { state: 'error', message: String(err && err.message || err) }));
autoUpdater.on('download-progress', (p) => sendToRenderer('updater:progress', { percent: p.percent }));
autoUpdater.on('update-downloaded', (info) => {
  sendToRenderer('updater:downloaded', { version: info && info.version });
});

ipcMain.handle('updater:check', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'dev-mode' };
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r && r.updateInfo && r.updateInfo.version };
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err) };
  }
});

ipcMain.handle('updater:quitAndInstall', () => {
  stopPythonServer();
  autoUpdater.quitAndInstall();
});

ipcMain.handle('app:version', () => app.getVersion());

// ---------- IPC ----------

ipcMain.handle('settings:get', () => ({
  outputDir: store.get('outputDir'),
  pythonPath: store.get('pythonPath'),
  serverPort: store.get('serverPort')
}));

ipcMain.handle('settings:set', (_evt, patch) => {
  for (const [k, v] of Object.entries(patch || {})) store.set(k, v);
  return true;
});

ipcMain.handle('dialog:pickSongs', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add ingredients (reference songs)',
    properties: ['openFile', 'multiSelections'],
    filters: [ { name: 'Audio', extensions: ['wav','mp3','aiff','aif','m4a','flac','ogg'] } ]
  });
  if (res.canceled) return [];
  return res.filePaths.map(p => ({ path: p, name: path.basename(p) }));
});

ipcMain.handle('dialog:pickOutputDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Pick output folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled) return null;
  store.set('outputDir', res.filePaths[0]);
  return res.filePaths[0];
});

ipcMain.handle('server:health', async () => checkHealth());
ipcMain.handle('server:warmup', async () => warmup());

ipcMain.handle('beat:generate', async (_evt, payload) => {
  const onProgress = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('beat:progress', msg);
  };
  return generateBeat({ ...payload, outputDir: store.get('outputDir'), onProgress });
});

ipcMain.handle('beat:reveal', async (_evt, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});

ipcMain.on('beat:startDrag', (evt, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return;
  evt.sender.startDrag({
    file: filePath,
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'drag-icon.png'))
      .resize({ width: 64, height: 64 })
  });
});
