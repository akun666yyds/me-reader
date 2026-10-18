const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 只暴露白名单通道：渲染层拿不到 ipcRenderer，也就不可能调用未登记的宿主能力。
 * agent/* 与 ws/* 统一返回 { ok, data, error } 信封，界面层用同一个 unwrap 处理失败。
 */
const AGENT_CHANNELS = [
  'agent/config', 'agent/config-set', 'agent/check', 'agent/models', 'agent/data-dir',
  'agent/sessions', 'agent/session/create', 'agent/session/load', 'agent/session/rename',
  'agent/session/pin', 'agent/session/delete', 'agent/session/cut', 'agent/session/export',
  'agent/image', 'agent/send', 'agent/stop', 'agent/decide', 'agent/approval', 'agent/status',
  'agent/usage', 'agent/context', 'agent/compress', 'agent/context-reset',
  'agent/memory', 'agent/memory-add', 'agent/memory-update', 'agent/memory-remove',
  'agent/skills', 'agent/skill-toggle', 'agent/skill-save', 'agent/skill-remove',
  'agent/rag-stats', 'agent/reindex', 'agent/rag-clear', 'agent/rag-query'
];

const WORKSPACE_CHANNELS = [
  'ws/list', 'ws/pick', 'ws/add', 'ws/activate', 'ws/rename', 'ws/remove',
  'ws/tree', 'ws/mkdir', 'ws/create-file', 'ws/move', 'ws/remove-file', 'ws/abs', 'ws/search',
  'ws/import-asset', 'ws/stat'
];

function bind(channel) {
  return (...args) => ipcRenderer.invoke(channel, ...args);
}

const agent = {};
for (const ch of AGENT_CHANNELS) agent[ch.replace(/[:/]/g, '_')] = bind(ch);

const ws = {};
for (const ch of WORKSPACE_CHANNELS) ws[ch.replace(/[:/]/g, '_')] = bind(ch);

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
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  agent,
  ws,
  on: (channel, handler) => {
    const allowed = ['menu:action', 'file:open-path', 'settings:changed', 'window:before-close', 'agent:event', 'project:added'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => handler(payload));
  }
});
