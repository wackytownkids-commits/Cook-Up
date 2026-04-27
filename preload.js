// Secure bridge between the renderer and Electron main.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  pickSongs: () => ipcRenderer.invoke('dialog:pickSongs'),
  pickOutputDir: () => ipcRenderer.invoke('dialog:pickOutputDir'),

  health: () => ipcRenderer.invoke('server:health'),
  warmup: () => ipcRenderer.invoke('server:warmup'),

  generate: (payload) => ipcRenderer.invoke('beat:generate', payload),
  reveal: (filePath) => ipcRenderer.invoke('beat:reveal', filePath),

  onProgress: (cb) => {
    const listener = (_evt, msg) => cb(msg);
    ipcRenderer.on('beat:progress', listener);
    return () => ipcRenderer.removeListener('beat:progress', listener);
  },
  onPyLog: (cb) => {
    const listener = (_evt, s) => cb(s);
    ipcRenderer.on('py:log', listener);
    return () => ipcRenderer.removeListener('py:log', listener);
  },
  onPyExit: (cb) => {
    const listener = (_evt, code) => cb(code);
    ipcRenderer.on('py:exit', listener);
    return () => ipcRenderer.removeListener('py:exit', listener);
  },

  startDrag: (filePath) => ipcRenderer.send('beat:startDrag', filePath),

  // Voice / effects
  saveRecording: (bytes) => ipcRenderer.invoke('voice:save', { bytes }),
  vocalToMidi: (payload) => ipcRenderer.invoke('voice:vocalToMidi', payload),
  applyFx: (payload) => ipcRenderer.invoke('fx:apply', payload),
  analyzeVocal: (payload) => ipcRenderer.invoke('fx:analyzeVocal', payload),
  pickAudio: () => ipcRenderer.invoke('files:pickAudio'),
  cancelJob: () => ipcRenderer.invoke('cook:cancel'),

  // Pro tier (license / dev toggle)
  setLicense: (key) => ipcRenderer.invoke('app:setLicense', key),
  toggleDevPro: () => ipcRenderer.invoke('app:toggleDevPro'),

  // Auto-updater
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),
  onUpdateStatus: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
  onUpdateProgress: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('updater:progress', listener);
    return () => ipcRenderer.removeListener('updater:progress', listener);
  },
  onUpdateDownloaded: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('updater:downloaded', listener);
    return () => ipcRenderer.removeListener('updater:downloaded', listener);
  }
});
