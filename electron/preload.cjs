'use strict';

const {contextBridge, ipcRenderer} = require('electron');

function invoke(name, payload) {
  return ipcRenderer.invoke(`skill-desk:${name}`, payload).then(result => {
    if (!result?.ok) throw new Error(result?.error || 'Не удалось выполнить действие.');
    return result.value;
  });
}

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Нужна функция обратного вызова.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => {ipcRenderer.removeListener(channel, listener);};
}

contextBridge.exposeInMainWorld('skillDesk', Object.freeze({
  getSnapshot: () => invoke('snapshot'),
  refresh: () => invoke('refresh'),
  openWidget: id => invoke('open-widget', id),
  setAlwaysOnTop: value => invoke('always-on-top', value),
  windowAction: action => invoke('window-action', action),
  setPreferences: value => invoke('preferences', value),
  onUpdate: callback => subscribe('skill-desk:update', callback),
  onNotice: callback => subscribe('skill-desk:notice', callback)
}));
