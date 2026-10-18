'use strict';

const {app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {normalizeState, validatePreferenceUpdate, sessionId, clampBounds, isTrustedIpc, createStateStore, MAX_WIDGETS} = require('./shell-state.cjs');

const APP_NAME = 'Skill Desk';
const APP_ID = app.isPackaged ? 'local.skill-desk' : 'local.skill-desk.development';
const PAGE_PATH = path.join(__dirname, '../ui/index.html');
const PAGE_URL = pathToFileURL(PAGE_PATH).href;
const ICON_PATH = path.join(__dirname, '../assets/icon.ico');
const TEST_MODE = process.env.SKILL_DESK_TEST === '1';
const ownedWindows = new Map();
const widgets = new Map();

let overview;
let tray;
let monitor;
let pollTimer;
let state = normalizeState();
let providerState = {sessions: [], warnings: [], generatedAt: null};
let store;
let quitting = false;
let ready = false;
let observerError = '';
let storageError = '';
let profileError;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

try {
  const override = process.env.SKILL_DESK_PROFILE;
  const base = process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA) ? process.env.LOCALAPPDATA : app.getPath('appData');
  const profile = override ? path.resolve(override) : path.join(base, APP_NAME);
  if (override && !path.isAbsolute(override)) throw new Error('SKILL_DESK_PROFILE должен быть абсолютным путём.');
  if (profile.split(/[\\/]/).some(part => part.toLowerCase() === '.codex')) throw new Error('Профиль приложения должен находиться вне служебной папки Codex.');
  fs.mkdirSync(profile, {recursive: true});
  app.setPath('userData', profile);
  store = createStateStore(profile);
  try { state = store.load(); }
  catch { storageError = 'Не удалось прочитать настройки окон. Используются настройки по умолчанию.'; }
} catch (error) { profileError = error; }

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

function notice(message) {
  for (const window of ownedWindows.values()) {
    if (!window.isDestroyed()) window.webContents.send('skill-desk:notice', message);
  }
}

function persist(next = state) {
  if (!store) throw new Error('Хранилище настроек недоступно.');
  try { store.save(next); storageError = ''; }
  catch {
    storageError = 'Не удалось сохранить настройки окон. Проверьте доступ к папке приложения.';
    notice(storageError);
    throw new Error(storageError);
  }
}

function saveQuietly() {
  try { persist(); } catch { /* The notice and status already explain the failed save. */ }
}

function windowInfo(window) {
  const id = window.__skillSessionId;
  return {kind: id ? 'widget' : 'overview', sessionId: id || null, alwaysOnTop: window.isAlwaysOnTop()};
}

function snapshot(window) {
  const warnings = [...(Array.isArray(providerState.warnings) ? providerState.warnings : [])];
  if (storageError) warnings.push(storageError);
  return {
    ...providerState,
    desktop: true,
    preferences: {...state.preferences},
    widgets: [...widgets.keys()],
    window: windowInfo(window),
    warnings,
    ...(observerError ? {error: observerError} : {})
  };
}

function broadcast() {
  for (const window of ownedWindows.values()) {
    if (!window.isDestroyed()) window.webContents.send('skill-desk:update', snapshot(window));
  }
}

function refresh() {
  try {
    if (!monitor) throw new Error('Источник данных недоступен.');
    const next = monitor.getState();
    if (!next || !Array.isArray(next.sessions)) throw new Error('Источник вернул неверные данные.');
    providerState = next;
    observerError = '';
  } catch {
    observerError = 'Не удалось прочитать локальные сессии Codex. Следующая попытка — через 3 секунды.';
  }
  broadcast();
}

function orderedDisplays() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().sort((a, b) => (b.id === primary.id) - (a.id === primary.id));
}

function captureBounds(window) {
  if (window.isDestroyed()) return;
  const saved = {bounds: window.getNormalBounds(), alwaysOnTop: window.isAlwaysOnTop()};
  const id = window.__skillSessionId;
  if (id) state.widgets[id] = {...state.widgets[id], ...saved, open: true};
  else state.overview = saved;
}

function configureSecurity(window) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({action: 'deny'}));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
}

function createWindow(id = null) {
  const widget = id !== null;
  const saved = widget ? state.widgets[id] : state.overview;
  const defaults = widget ? {width: 400, height: 300, minWidth: 330, minHeight: 230} : {width: 1100, height: 790, minWidth: 660, minHeight: 500};
  const bounds = clampBounds(saved?.bounds, orderedDisplays(), defaults);
  const window = new BrowserWindow({
    ...bounds,
    minWidth: Math.min(defaults.minWidth, bounds.width), minHeight: Math.min(defaults.minHeight, bounds.height),
    show: false, frame: false, autoHideMenuBar: true,
    backgroundColor: state.preferences.theme === 'light' ? '#f4f5f7' : '#141619',
    title: widget ? `${APP_NAME} · Сессия` : APP_NAME,
    icon: ICON_PATH, alwaysOnTop: widget ? saved?.alwaysOnTop !== false : saved?.alwaysOnTop === true,
    webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false}
  });
  window.__skillSessionId = id;
  ownedWindows.set(window.webContents.id, window);
  if (widget) widgets.set(id, window);
  else overview = window;
  if (process.platform === 'win32') {
    window.setAppDetails({appId: APP_ID, appIconPath: ICON_PATH, appIconIndex: 0, relaunchCommand: `"${process.execPath}"${app.isPackaged ? '' : ` "${app.getAppPath()}"`}`, relaunchDisplayName: APP_NAME});
  }
  configureSecurity(window);
  window.loadFile(PAGE_PATH, {query: widget ? {widget: id} : {}}).catch(() => notice('Не удалось загрузить интерфейс Skill Desk.'));
  window.once('ready-to-show', () => {if (!TEST_MODE) window.show();});
  window.webContents.on('did-finish-load', () => {if (!window.isDestroyed()) window.webContents.send('skill-desk:update', snapshot(window));});

  let boundsTimer;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {if (!window.isDestroyed()) {captureBounds(window); saveQuietly();}}, 250);
  };
  window.on('move', saveBounds);
  window.on('resize', saveBounds);
  window.on('close', event => {
    clearTimeout(boundsTimer);
    captureBounds(window);
    if (!widget && !quitting) {
      event.preventDefault(); window.hide(); saveQuietly();
      return;
    }
    if (widget && !quitting) state.widgets[id].open = false;
    saveQuietly();
  });
  const webContentsId = window.webContents.id;
  window.on('closed', () => {
    clearTimeout(boundsTimer);
    ownedWindows.delete(webContentsId);
    if (widget) widgets.delete(id);
    else if (overview === window) overview = undefined;
    if (!quitting) broadcast();
  });
  return window;
}

function showOverview() {
  if (!ready || quitting) return;
  if (!overview || overview.isDestroyed()) overview = createWindow();
  if (overview.isMinimized()) overview.restore();
  if (!TEST_MODE) {overview.show(); overview.focus();}
}

function openWidget(id) {
  if (!sessionId(id) || !providerState.sessions.some(session => session.id === id)) throw new Error('Сессия не найдена. Обновите список.');
  let window = widgets.get(id);
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    if (!TEST_MODE) {window.show(); window.focus();}
    return;
  }
  if (widgets.size >= MAX_WIDGETS) throw new Error('Открыто слишком много виджетов. Закройте один из них.');
  if (!Object.hasOwn(state.widgets, id) && Object.keys(state.widgets).length >= MAX_WIDGETS) {
    const old = Object.keys(state.widgets).find(key => !state.widgets[key].open);
    if (old) delete state.widgets[old];
  }
  state.widgets[id] = {...state.widgets[id], alwaysOnTop: state.widgets[id]?.alwaysOnTop !== false, open: true};
  window = createWindow(id);
  captureBounds(window);
  saveQuietly();
  broadcast();
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, '../assets/icon.png'));
  tray = new Tray(image.isEmpty() ? ICON_PATH : image.resize({width: 20, height: 20}));
  tray.setToolTip('Skill Desk — скиллы и сессии Codex');
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: 'Открыть Skill Desk', click: showOverview},
    {label: 'Обновить', click: refresh},
    {type: 'separator'},
    {label: 'Выйти', click: () => app.quit()}
  ]));
  tray.on('click', showOverview);
  tray.on('double-click', showOverview);
}

function register(name, handler) {
  ipcMain.handle(`skill-desk:${name}`, async (event, payload) => {
    try {
      if (!isTrustedIpc(event, PAGE_URL, ownedWindows)) throw new Error('Недопустимый источник запроса.');
      const window = ownedWindows.get(event.sender.id);
      return {ok: true, value: await handler(payload, window)};
    } catch (error) {return {ok: false, error: error.message || 'Не удалось выполнить действие.'};}
  });
}

function registerIpc() {
  register('snapshot', (_payload, window) => snapshot(window));
  register('refresh', (_payload, window) => {refresh(); return snapshot(window);});
  register('open-widget', (id, window) => {openWidget(id); return snapshot(window);});
  register('always-on-top', (value, window) => {
    if (typeof value !== 'boolean') throw new Error('Некорректное состояние закрепления.');
    window.setAlwaysOnTop(value);
    captureBounds(window); persist(); broadcast();
    return snapshot(window);
  });
  register('preferences', (input, window) => {
    const preferences = {...state.preferences, ...validatePreferenceUpdate(input)};
    const next = {...state, preferences};
    persist(next); state = next; broadcast();
    return snapshot(window);
  });
  register('window-action', (action, window) => {
    if (!['minimize', 'close', 'overview', 'quit'].includes(action)) throw new Error('Неизвестное действие окна.');
    const result = snapshot(window);
    if (action === 'minimize') window.minimize();
    if (action === 'overview') showOverview();
    if (action === 'close') setImmediate(() => {if (!window.isDestroyed()) window.close();});
    if (action === 'quit') setImmediate(() => app.quit());
    return result;
  });
}

async function bootstrap() {
  if (profileError) throw profileError;
  const {createMonitor} = await import(pathToFileURL(path.join(__dirname, '../lib/monitor.mjs')).href);
  monitor = createMonitor();
  refresh();
  registerIpc();
  createTray();
  ready = true;
  createWindow();
  if (!TEST_MODE) {
    for (const [id, saved] of Object.entries(state.widgets)) {
      if (saved.open && providerState.sessions.some(session => session.id === id)) createWindow(id);
    }
  }
  pollTimer = setInterval(refresh, 3000);
}

if (singleInstance) {
  app.on('second-instance', showOverview);
  app.on('activate', showOverview);
  app.on('window-all-closed', () => { /* The tray keeps the app running. */ });
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(pollTimer);
    for (const window of ownedWindows.values()) captureBounds(window);
    saveQuietly();
    monitor?.close();
  });
  app.on('will-quit', () => tray?.destroy());
  app.whenReady().then(bootstrap).catch(error => {
    if (!TEST_MODE) dialog.showErrorBox('Skill Desk', error.message || 'Не удалось запустить приложение.');
    console.error('Skill Desk startup failed:', error.message);
    app.quit();
  });
}
