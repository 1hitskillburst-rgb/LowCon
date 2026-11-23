const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('lowconDesktop', {
  isDesktop: true,
  platform: process.platform,
});
