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
  handoff: (id, cols, rows) => ipcRenderer.invoke('session:handoff', id, cols, rows),

  changes: (id) => ipcRenderer.invoke('changes:list', id),
  changeDiff: (id, rel) => ipcRenderer.invoke('changes:diff', id, rel),
  revertChange: (id, rel) => ipcRenderer.invoke('changes:revert', id, rel),

  timeline: (id) => ipcRenderer.invoke('timeline:list', id),
  timelineDiff: (id, ev) => ipcRenderer.invoke('timeline:diff', id, ev),
  timelineUndoTo: (id, ev) => ipcRenderer.invoke('timeline:undoTo', id, ev),

  searchFiles: (q) => ipcRenderer.invoke('search:files', q),
  searchChats: (q) => ipcRenderer.invoke('search:chats', q),
  resumeChat: (claudeId, title, cols, rows) => ipcRenderer.invoke('session:resumeChat', claudeId, title, cols, rows),

  snippets: () => ipcRenderer.invoke('snippets:get'),
  setSnippets: (list) => ipcRenderer.invoke('snippets:set', list),

  gitStatus: () => ipcRenderer.invoke('git:status'),
  gitDiff: (rel, staged) => ipcRenderer.invoke('git:diff', rel, staged),
  gitStage: (paths) => ipcRenderer.invoke('git:stage', paths),
  gitUnstage: (paths) => ipcRenderer.invoke('git:unstage', paths),
  gitCommit: (msg) => ipcRenderer.invoke('git:commit', msg),
  gitPush: () => ipcRenderer.invoke('git:push'),
  gitSuggest: () => ipcRenderer.invoke('git:suggest'),

  queue: () => ipcRenderer.invoke('queue:list'),
  queueAdd: (item) => ipcRenderer.invoke('queue:add', item),
  queueRemove: (id) => ipcRenderer.invoke('queue:remove', id),
  queueStart: () => ipcRenderer.invoke('queue:start'),
  queueStop: () => ipcRenderer.invoke('queue:stop'),
  queueDiff: (id) => ipcRenderer.invoke('queue:diff', id),
  queueApply: (id) => ipcRenderer.invoke('queue:apply', id),
  queueDiscard: (id) => ipcRenderer.invoke('queue:discard', id),

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
  onChanges: on('changes:update'),
  onQueue: on('queue:update'),
});
