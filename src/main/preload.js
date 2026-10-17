const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mreader', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  openDialog: () => ipcRenderer.invoke('file:open-dialog'),
  saveDialog: (name) => ipcRenderer.invoke('file:save-dialog', name),
  writeFile: (filePath, content) => ipcRenderer.invoke('file:write', { filePath, content }),
  reveal: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
  confirmClose: (name) => ipcRenderer.invoke('dialog:confirm-close', name),
  confirmCloseMulti: (names) => ipcRenderer.invoke('dialog:confirm-close-multi', names),
  rename: (filePath, newName) => ipcRenderer.invoke('file:rename', { filePath, newName }),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  autosave: (data) => ipcRenderer.send('autosave:write', data),
  clearAutosave: () => ipcRenderer.send('autosave:clear'),
  forceClose: () => ipcRenderer.send('window:force-close'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (channel, handler) => ipcRenderer.on(channel, (_e, payload) => handler(payload))
});
