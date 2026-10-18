'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PREFERENCES = Object.freeze({theme: 'dark', view: 'grid', showSubagents: false});
const MAX_WIDGETS = 32;

function sessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizePreferences(value = {}) {
  return {
    theme: ['dark', 'light'].includes(value?.theme) ? value.theme : DEFAULT_PREFERENCES.theme,
    view: ['grid', 'list'].includes(value?.view) ? value.view : DEFAULT_PREFERENCES.view,
    showSubagents: typeof value?.showSubagents === 'boolean' ? value.showSubagents : false
  };
}

function validatePreferenceUpdate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректные настройки.');
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULT_PREFERENCES, key))) throw new Error('Неизвестная настройка.');
  if (Object.hasOwn(value, 'theme') && !['dark', 'light'].includes(value.theme)) throw new Error('Неизвестная тема.');
  if (Object.hasOwn(value, 'view') && !['grid', 'list'].includes(value.view)) throw new Error('Неизвестный вид списка.');
  if (Object.hasOwn(value, 'showSubagents') && typeof value.showSubagents !== 'boolean') throw new Error('Некорректный фильтр агентов.');
  return {...value};
}

function validBounds(value) {
  if (!value || typeof value !== 'object') return null;
  if (['x', 'y', 'width', 'height'].some(key => !Number.isFinite(value[key]))) return null;
  if (value.width < 100 || value.height < 80 || value.width > 20000 || value.height > 20000) return null;
  if (Math.abs(value.x) > 100000 || Math.abs(value.y) > 100000) return null;
  return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(value[key])]));
}

function normalizeState(input) {
  const value = input && typeof input === 'object' ? input : {};
  const widgets = Object.create(null);
  if (value.widgets && typeof value.widgets === 'object' && !Array.isArray(value.widgets)) {
    for (const [id, saved] of Object.entries(value.widgets).slice(0, MAX_WIDGETS)) {
      if (!sessionId(id) || !saved || typeof saved !== 'object') continue;
      widgets[id] = {bounds: validBounds(saved.bounds), alwaysOnTop: saved.alwaysOnTop !== false, open: saved.open === true};
    }
  }
  return {
    version: 1,
    preferences: normalizePreferences(value.preferences),
    overview: {bounds: validBounds(value.overview?.bounds), alwaysOnTop: value.overview?.alwaysOnTop === true},
    widgets
  };
}

function clampBounds(saved, displays, defaults = {width: 1100, height: 790, minWidth: 660, minHeight: 500}) {
  const areas = displays.map(display => display.workArea || display).filter(area => area.width > 0 && area.height > 0);
  if (!areas.length) return {width: defaults.width, height: defaults.height};
  const bounds = validBounds(saved);
  const overlap = area => bounds ? Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)) * Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)) : 0;
  const area = bounds ? [...areas].sort((a, b) => overlap(b) - overlap(a))[0] : areas[0];
  const width = Math.min(area.width, Math.max(defaults.minWidth, bounds?.width || defaults.width));
  const height = Math.min(area.height, Math.max(defaults.minHeight, bounds?.height || defaults.height));
  const hasOverlap = overlap(area) > 0;
  const x = bounds && hasOverlap ? bounds.x : area.x + (area.width - width) / 2;
  const y = bounds && hasOverlap ? bounds.y : area.y + (area.height - height) / 2;
  return {x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - width)), y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - height)), width: Math.round(width), height: Math.round(height)};
}

function isTrustedPageUrl(value, expected) {
  try {
    const actual = new URL(value);
    const target = new URL(expected);
    if (actual.protocol !== 'file:' || target.protocol !== 'file:') return false;
    actual.search = ''; actual.hash = '';
    target.search = ''; target.hash = '';
    return actual.href === target.href;
  } catch { return false; }
}

function isTrustedIpc(event, pageUrl, ownedWebContents) {
  try {
    return !!event?.sender && !event.sender.isDestroyed() && ownedWebContents.has(event.sender.id)
      && event.senderFrame === event.sender.mainFrame && isTrustedPageUrl(event.senderFrame.url, pageUrl);
  } catch { return false; }
}

function createStateStore(directory) {
  const file = path.join(directory, 'desktop-state.json');
  fs.mkdirSync(directory, {recursive: true});
  return {
    file,
    load() {
      try { return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8'))); }
      catch (error) { if (error.code === 'ENOENT') return normalizeState(); throw error; }
    },
    save(state) {
      const temporary = path.join(directory, `.desktop-state-${process.pid}.tmp`);
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, 'w', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(normalizeState(state), null, 2), 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor); descriptor = undefined;
        fs.renameSync(temporary, file);
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  };
}

module.exports = {DEFAULT_PREFERENCES, MAX_WIDGETS, sessionId, normalizePreferences, validatePreferenceUpdate, validBounds, normalizeState, clampBounds, isTrustedPageUrl, isTrustedIpc, createStateStore};
