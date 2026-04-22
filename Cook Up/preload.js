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

  startDrag: (filePath) => ipcRenderer.send('beat:startDrag', filePath)
});
