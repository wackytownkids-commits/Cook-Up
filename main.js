// Cookup - Electron main process
// Spawns the local Python MusicGen server, manages the window, handles
// file dialogs and the drag-out-to-DAW flow.

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fetch = require('node-fetch');

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
    serverPort: 7781,
    inputDeviceId: '',
    proEnabled: false,
    licenseKey: '',
    licenseValidatedAt: '',  // ISO timestamp of last successful Gumroad verify
    licenseHash: '',         // sha256 of the trimmed key, used to detect changes
    licenseEmail: '',        // buyer email from purchase response, for support
  }
});

// ---------- Gumroad license validation ----------
// Pattern: online verify on save -> cache the validatedAt timestamp.
// Re-verify online whenever the cache is older than ONLINE_RECHECK_DAYS.
// If the network is unreachable, allow Pro to keep working until the
// cache is older than OFFLINE_GRACE_DAYS - then fall back to Free and
// surface a toast prompting re-verify.

const GUMROAD_PRODUCT_ID = 'isHPZgjCdwO1DbDJdN7ExQ==';
const GUMROAD_VERIFY_URL = 'https://api.gumroad.com/v2/licenses/verify';
const ONLINE_RECHECK_DAYS = 7;
const OFFLINE_GRACE_DAYS = 30;
const LEGACY_STUB_KEY_RE = /^KU-PRO-[A-Za-z0-9]{16}$/;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function daysSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

async function gumroadVerify(licenseKey, incrementUses) {
  const body = new URLSearchParams({
    product_id: GUMROAD_PRODUCT_ID,
    license_key: String(licenseKey || '').trim(),
    increment_uses_count: incrementUses ? 'true' : 'false',
  });
  try {
    const res = await fetch(GUMROAD_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      timeout: 10000,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    log.warn('gumroad verify network error', err && err.message);
    return { networkError: true, error: String(err && err.message || err) };
  }
}

// Verify a key against Gumroad and persist the result. Decides whether
// to bump Gumroad's `uses` counter by hashing the key — the counter is
// only bumped the first time we see a given key on this machine.
async function validateAndStoreLicense(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) {
    return { ok: false, message: 'Enter a license key first.' };
  }
  const newHash = sha256(key);
  const incrementUses = newHash !== store.get('licenseHash');
  const r = await gumroadVerify(key, incrementUses);
  if (r.networkError) {
    return { ok: false, networkError: true,
             message: "Couldn't reach Gumroad. Check your internet and try again." };
  }
  const data = r.data || {};
  if (!r.ok || !data.success) {
    return { ok: false,
             message: data.message || 'License key is not valid for this product.' };
  }
  const purchase = data.purchase || {};
  if (purchase.refunded) {
    return { ok: false, message: 'This license was refunded.' };
  }
  if (purchase.disputed) {
    return { ok: false, message: 'This license is disputed.' };
  }
  // Success: persist.
  store.set('licenseKey', key);
  store.set('licenseHash', newHash);
  store.set('licenseValidatedAt', new Date().toISOString());
  store.set('licenseEmail', purchase.email || '');
  return { ok: true, email: purchase.email || '', uses: data.uses };
}

async function startupRevalidate() {
  const key = store.get('licenseKey');
  if (!key) return;
  // Migrate v1.1.4 stub keys: if it looks like KU-PRO-{16} and was never
  // backed by a real Gumroad verify (no validatedAt, or validatedAt was
  // never set because v1.1.4 didn't write one), silently clear it.
  if (LEGACY_STUB_KEY_RE.test(key) && !store.get('licenseValidatedAt')) {
    log.info('clearing v1.1.4 stub license key on first v1.1.5+ launch');
    store.set('licenseKey', '');
    store.set('licenseHash', '');
    return;
  }
  const age = daysSince(store.get('licenseValidatedAt'));
  if (age < ONLINE_RECHECK_DAYS) return;  // cache still fresh
  const r = await gumroadVerify(key, false);
  if (r.networkError || !r.ok || !(r.data && r.data.success)) {
    // Online failed. If we're past the offline grace period, surface a
    // toast so the user knows they need to re-verify.
    if (age > OFFLINE_GRACE_DAYS) {
      sendToRenderer('license:needsReverify', { lastValidatedAt: store.get('licenseValidatedAt') });
    }
    return;
  }
  // Online succeeded - extend the cache.
  store.set('licenseValidatedAt', new Date().toISOString());
}

function recomputeProState() {
  // Dev backdoor wins over everything.
  if (store.get('proEnabled')) return true;
  const key = store.get('licenseKey');
  if (!key) return false;
  // Legacy stubs are already cleared in startupRevalidate, but defend
  // here for any code path that runs before that.
  if (LEGACY_STUB_KEY_RE.test(key) && !store.get('licenseValidatedAt')) return false;
  const age = daysSince(store.get('licenseValidatedAt'));
  return age < OFFLINE_GRACE_DAYS;
}

function licensePublicSummary() {
  const key = store.get('licenseKey');
  const validatedAt = store.get('licenseValidatedAt');
  if (!key || !validatedAt) return null;
  if (LEGACY_STUB_KEY_RE.test(key) && !validatedAt) return null;
  return {
    last4: key.length >= 4 ? key.slice(-4) : key,
    validatedAt,
    email: store.get('licenseEmail') || '',
  };
}

const {
  generateBeat,
  vocalToMidi,
  applyEffects,
  analyzeVocal,
  cancelJob,
  checkHealth,
  warmup,
} = require('./src/generator');

let mainWindow;
let pyProc = null;

const IS_WIN = process.platform === 'win32';

function resolveIconPath() {
  // Packaged: extraResources copies icon.ico/icon.png next to resources/.
  // Dev: read from build/ in the project root.
  const fname = IS_WIN ? 'icon.ico' : 'icon.png';
  if (app.isPackaged) {
    const packed = path.join(process.resourcesPath, fname);
    if (fs.existsSync(packed)) return packed;
  }
  return path.join(__dirname, 'build', fname);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 820,
    minWidth: 440,
    minHeight: 680,
    backgroundColor: '#0e0e10',
    icon: resolveIconPath(),
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
  // Pin Windows taskbar grouping to our app id so the taskbar icon
  // matches the BrowserWindow icon and the installed shortcut.
  if (IS_WIN) {
    try { app.setAppUserModelId('com.cory.cookup'); } catch (_) {}
  }
  createWindow();
  // Belt-and-suspenders: re-set the icon after window creation, since on
  // some Windows builds the constructor option is silently dropped if the
  // path resolves through asar.
  if (IS_WIN && mainWindow) {
    try {
      const ico = resolveIconPath();
      if (ico && fs.existsSync(ico)) mainWindow.setIcon(nativeImage.createFromPath(ico));
    } catch (_) {}
  }
  startPythonServer();
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => log.warn('Update check failed', err));
  }
  // Quietly re-verify the cached license against Gumroad if our cached
  // validation is more than a week old. This is fire-and-forget.
  startupRevalidate().catch((err) => log.warn('License revalidate failed', err));
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

// Translate raw electron-updater errors (which can include 200KB of GitHub
// 502 HTML when the API is having a bad day) into a short readable message.
function friendlyUpdaterError(err) {
  const raw = String(err && err.message || err || 'unknown');
  // YAML/JSON parse errors against an HTML 502 page: detect tags or "502".
  if (/^\s*<|<html|<\/?\w+>|Bad\s*Gateway|502\b/i.test(raw)) {
    return "Couldn't reach GitHub right now - try again in a minute.";
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|offline/i.test(raw)) {
    return "Network unavailable - check your connection.";
  }
  if (/rate.?limit/i.test(raw)) {
    return "GitHub rate-limit hit - try again in a minute.";
  }
  // Trim ridiculously long messages.
  return raw.length > 240 ? raw.slice(0, 240) + '...' : raw;
}

autoUpdater.on('checking-for-update', () => sendToRenderer('updater:status', { state: 'checking' }));
autoUpdater.on('update-available', (info) => sendToRenderer('updater:status', { state: 'available', version: info && info.version }));
autoUpdater.on('update-not-available', () => sendToRenderer('updater:status', { state: 'none' }));
autoUpdater.on('error', (err) => sendToRenderer('updater:status', { state: 'error', message: friendlyUpdaterError(err) }));
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
    return { ok: false, reason: friendlyUpdaterError(err) };
  }
});

ipcMain.handle('updater:quitAndInstall', () => {
  stopPythonServer();
  autoUpdater.quitAndInstall();
});

ipcMain.handle('app:version', () => app.getVersion());

// ---------- IPC ----------

ipcMain.handle('settings:get', () => {
  const dev = !!store.get('proEnabled');
  const license = licensePublicSummary();
  const pro = recomputeProState();
  let proSource = 'free';
  if (dev) proSource = 'dev';
  else if (pro && license) proSource = 'license';
  return {
    outputDir: store.get('outputDir'),
    pythonPath: store.get('pythonPath'),
    serverPort: store.get('serverPort'),
    inputDeviceId: store.get('inputDeviceId'),
    proEnabled: pro,
    proSource,
    license,  // null when not activated, else { last4, validatedAt, email }
  };
});

ipcMain.handle('app:setLicense', async (_evt, key) => {
  const result = await validateAndStoreLicense(key);
  return {
    ...result,
    proEnabled: recomputeProState(),
    license: licensePublicSummary(),
  };
});

ipcMain.handle('app:deactivateLicense', () => {
  store.set('licenseKey', '');
  store.set('licenseHash', '');
  store.set('licenseValidatedAt', '');
  store.set('licenseEmail', '');
  return { proEnabled: recomputeProState() };
});

ipcMain.handle('app:toggleDevPro', () => {
  // Dev-only backdoor. Hidden behind Ctrl+Shift+P in the Settings dialog.
  // No UI affordance points at it; discoverable from source. Don't
  // advertise it. Bypasses the Gumroad path entirely.
  const next = !store.get('proEnabled');
  store.set('proEnabled', next);
  return { proEnabled: recomputeProState(), dev: next };
});

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

// Track the AbortController for the in-flight long job, if any. Cancel
// fires both the cooperative HTTP /cancel (the primary path — Python
// raises CancelledByUser inside the generation loop) AND aborts the
// fetch as a fallback in case the connection itself wedges (e.g. Python
// crashes silently and the socket never returns).
let activeJobController = null;

function withJobController(handler) {
  return async (...args) => {
    const ctrl = new AbortController();
    activeJobController = ctrl;
    try {
      return await handler(ctrl.signal, ...args);
    } finally {
      if (activeJobController === ctrl) activeJobController = null;
    }
  };
}

ipcMain.handle('beat:generate', withJobController(async (signal, _evt, payload) => {
  const onProgress = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('beat:progress', msg);
  };
  return generateBeat({ ...payload, outputDir: store.get('outputDir'), onProgress, signal });
}));

ipcMain.handle('cook:cancel', async () => {
  // Cooperative cancel via HTTP (server raises CancelledByUser at next
  // checkpoint). Then abort the fetch so we don't await a dead socket.
  const result = await cancelJob();
  if (activeJobController) {
    try { activeJobController.abort(); } catch (_) {}
  }
  return result;
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

// ---------- voice / effects IPC ----------

// Save a WAV blob recorded in the renderer to a temp path so the Python
// server (and downstream tools like fluidsynth) can read it from disk.
ipcMain.handle('voice:save', async (_evt, { bytes, suffix = '.wav' }) => {
  const dir = path.join(os.tmpdir(), 'cookup-voice');
  fs.mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const file = path.join(dir, `recording-${ts}${suffix}`);
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
});

ipcMain.handle('voice:vocalToMidi', withJobController(async (signal, _evt, { vocalPath, mode, instrument, isDrums }) => {
  return vocalToMidi({
    vocalPath, mode, instrument, isDrums,
    outputDir: store.get('outputDir'),
    signal,
  });
}));

ipcMain.handle('fx:apply', withJobController(async (signal, _evt, { inputPath, chain }) => {
  return applyEffects({
    inputPath, chain,
    outputDir: store.get('outputDir'),
    signal,
  });
}));

ipcMain.handle('fx:analyzeVocal', async (_evt, { inputPath }) => {
  return analyzeVocal({ inputPath });
});

ipcMain.handle('files:pickAudio', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Pick an audio file',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'aiff', 'aif', 'm4a', 'flac', 'ogg'] }],
  });
  if (res.canceled) return null;
  return res.filePaths[0];
});
