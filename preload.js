const { contextBridge, ipcRenderer: ipc } = require('electron');
contextBridge.exposeInMainWorld('hb', {
  getState: () => ipc.invoke('get-state'), cloudAuth: o => ipc.invoke('cloud-auth', o), cloudLogout: () => ipc.invoke('cloud-logout'), cloudSync: () => ipc.invoke('cloud-sync'), listCharacters: () => ipc.invoke('list-characters'), openCharactersFolder: () => ipc.invoke('open-characters-folder'), getData: () => ipc.invoke('get-data'),
  setSettings: p => ipc.invoke('set-settings', p), onboarded: () => ipc.invoke('onboarded'),
  addLog: a => ipc.invoke('add-log', a), editLog: (id, a) => ipc.invoke('edit-log', id, a), deleteLog: id => ipc.invoke('delete-log', id),
  testBuddy: () => ipc.invoke('test-buddy'), pause: v => ipc.invoke('pause', v), skipToday: on => ipc.invoke('skip-today', on),
  onState: cb => ipc.on('state', (_e, s) => cb(s)),
  onStart: cb => ipc.on('start', (_e, p) => cb(p)),
  respond: (action, amount) => ipc.send('buddy-respond', { action, amount }),
  finished: () => ipc.send('buddy-finished'), ignoreMouse: b => ipc.send('buddy-ignore-mouse', b)
});
