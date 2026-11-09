'use strict';
// The only bridge between the page and Electron: a handful of fire-and-forget calls.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['open-chat', 'compose', 'settings'];

contextBridge.exposeInMainWorld('imassage', {
  badge: (count, dataUrl) => ipcRenderer.send('badge', count, dataUrl),
  notify: n => ipcRenderer.send('notify', n),
  attention: () => ipcRenderer.send('attention'),
  emoji: () => ipcRenderer.send('emoji'),
  focus: () => ipcRenderer.send('focus'),
  settings: () => ipcRenderer.invoke('settings'),
  on: (channel, fn) => {
    if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
});
