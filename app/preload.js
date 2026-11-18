// The only bridge between the window and the main process. The page gets these
// functions and nothing else: no Node, no filesystem, no shell.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, data) => fn(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};

contextBridge.exposeInMainWorld('meta', {
  state: () => ipcRenderer.invoke('state:get'),
  openFolder: () => ipcRenderer.invoke('project:pick'),
  setProject: (dir) => ipcRenderer.invoke('project:set', dir),

  createSession: (opts) => ipcRenderer.invoke('session:create', opts),
  attach: (id, cols, rows) => ipcRenderer.invoke('session:attach', id, cols, rows),
  write: (id, data) => ipcRenderer.send('session:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('session:resize', id, cols, rows),
  closeSession: (id) => ipcRenderer.invoke('session:close', id),
  renameSession: (id, name) => ipcRenderer.invoke('session:rename', id, name),
  setActive: (id) => ipcRenderer.send('session:active', id),

  listFiles: () => ipcRenderer.invoke('fs:list'),
  readFile: (rel) => ipcRenderer.invoke('fs:read', rel),
  reveal: (rel) => ipcRenderer.invoke('fs:reveal', rel),

  tokens: () => ipcRenderer.invoke('tokens:get'),
  clipboardRead: () => ipcRenderer.invoke('clip:read'),
  clipboardWrite: (text) => ipcRenderer.invoke('clip:write', text),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  onData: on('pty:data'),
  onExit: on('pty:exit'),
  onStatus: on('session:status'),
  onFocusSession: on('session:focus'),
  onFsChanged: on('fs:changed'),
  onTokens: on('tokens:update'),
});
