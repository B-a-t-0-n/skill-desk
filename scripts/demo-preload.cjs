'use strict';

const {contextBridge} = require('electron');
const argument = process.argv.find(value => value.startsWith('--skill-desk-demo='));
if (!argument) throw new Error('The documentation fixture is required.');
let data = JSON.parse(Buffer.from(argument.slice('--skill-desk-demo='.length), 'base64').toString('utf8'));
const listeners = new Set();
const clone = value => JSON.parse(JSON.stringify(value));
function publish() {for (const listener of listeners) listener(clone(data));}

contextBridge.exposeInMainWorld('skillDesk', Object.freeze({
  getSnapshot: async () => clone(data),
  refresh: async () => clone(data),
  setPreferences: async preferences => {
    data.preferences = {...data.preferences, ...preferences};
    publish();
    return clone(data);
  },
  setAlwaysOnTop: async value => {
    data.window.alwaysOnTop = Boolean(value);
    return data.window.alwaysOnTop;
  },
  openWidget: async () => undefined,
  windowAction: async () => undefined,
  onUpdate: listener => {listeners.add(listener); return () => listeners.delete(listener);},
  onNotice: () => () => {}
}));
