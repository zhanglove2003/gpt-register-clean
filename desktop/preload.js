const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  getSummary: () => ipcRenderer.invoke('app:summary'),
  resetStats: () => ipcRenderer.invoke('stats:reset'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  openProjectFolder: () => ipcRenderer.invoke('config:open-folder'),
  
  openTokenDir: () => ipcRenderer.invoke('token:open-dir'),
  getTokenStatus: () => ipcRenderer.invoke('token:status'),
  getHeroSmsOverview: () => ipcRenderer.invoke('herosms:overview'),
  testMail: () => ipcRenderer.invoke('mail:test'),
  startRun: (options) => ipcRenderer.invoke('runtime:start', options),
  stopRun: () => ipcRenderer.invoke('runtime:stop'),
  onRuntimeLog: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('runtime:log', listener);
    return () => ipcRenderer.removeListener('runtime:log', listener);
  },
  onRuntimeState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('runtime:state', listener);
    return () => ipcRenderer.removeListener('runtime:state', listener);
  },
});


