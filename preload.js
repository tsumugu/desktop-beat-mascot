const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mascot', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  moveWindowBy: (dx, dy) => ipcRenderer.send('move-window-by', { dx, dy }),
  expandWindowBy: (dy) => ipcRenderer.send('expand-window-by', dy),
  quit: () => ipcRenderer.send('quit-app')
});
