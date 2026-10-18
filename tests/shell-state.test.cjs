'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {normalizeState, validatePreferenceUpdate, clampBounds, isTrustedPageUrl, isTrustedIpc, createStateStore} = require('../electron/shell-state.cjs');

test('restored bounds stay inside a connected monitor after display removal', () => {
  const area = {x: 0, y: 0, width: 1280, height: 720};
  const result = clampBounds({x: 3900, y: -100, width: 1600, height: 900}, [area]);
  assert.deepEqual(result, {x: 0, y: 0, width: 1280, height: 720});
});

test('restored windows retain the connected secondary monitor and clamp exposed edges', () => {
  const displays = [{workArea: {x: 0, y: 0, width: 1920, height: 1040}}, {workArea: {x: -1600, y: 0, width: 1600, height: 900}}];
  assert.deepEqual(clampBounds({x: -1700, y: 800, width: 400, height: 360}, displays, {width: 400, height: 360, minWidth: 330, minHeight: 180}), {x: -1600, y: 540, width: 400, height: 360});
});

test('only a registered top-level local UI frame can send IPC', () => {
  const expected = 'file:///C:/Skill%20Desk/ui/index.html';
  const frame = {url: `${expected}?widget=session-123`};
  const sender = {id: 8, mainFrame: frame, isDestroyed: () => false};
  const event = {sender, senderFrame: frame};
  assert.equal(isTrustedIpc(event, expected, new Map([[8, {}]])), true);
  assert.equal(isTrustedIpc(event, expected, new Map()), false);
  assert.equal(isTrustedIpc({...event, senderFrame: {url: expected}}, expected, new Map([[8, {}]])), false);
  assert.equal(isTrustedPageUrl('https://example.com/ui/index.html', expected), false);
  assert.equal(isTrustedPageUrl('file:///C:/Skill%20Desk/ui/other.html', expected), false);
  assert.equal(isTrustedPageUrl('file://untrusted/C:/Skill%20Desk/ui/index.html', expected), false);
  assert.equal(isTrustedPageUrl('invalid URL', expected), false);
  sender.isDestroyed = () => true;
  assert.equal(isTrustedIpc(event, expected, new Map([[8, {}]])), false);
});

test('preferences reject unknown fields and invalid renderer values', () => {
  assert.deepEqual(validatePreferenceUpdate({theme: 'light', showSubagents: true}), {theme: 'light', showSubagents: true});
  for (const value of [null, [], {theme: 'auto'}, {view: 'anything'}, {showSubagents: 'true'}, {profile: 'C:\\other'}]) {
    assert.throws(() => validatePreferenceUpdate(value));
  }
});

test('malformed saved state cannot restore invalid geometry or unbounded windows', () => {
  const widgets = Object.fromEntries(Array.from({length: 100}, (_, index) => [`session-${index}`, {open: true, bounds: {x: 0, y: 0, width: 400, height: 360}}]));
  const restored = normalizeState({preferences: {theme: 'invalid', showSubagents: 'yes'}, overview: {bounds: {x: Infinity, y: 0, width: 10, height: 10}}, widgets});
  assert.deepEqual(restored.preferences, {theme: 'dark', view: 'grid', showSubagents: false});
  assert.equal(restored.overview.bounds, null);
  assert.equal(Object.keys(restored.widgets).length, 32);
});

test('desktop preferences and pinned widgets survive an atomic save without altering other files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-desk-shell-'));
  try {
    const sentinel = path.join(directory, 'unrelated.txt');
    fs.writeFileSync(sentinel, 'untouched');
    const store = createStateStore(directory);
    const state = normalizeState();
    state.preferences.theme = 'light';
    state.widgets.session = {open: true, alwaysOnTop: false, bounds: {x: 20, y: 30, width: 400, height: 360}};
    store.save(state);
    state.widgets.session.alwaysOnTop = true;
    store.save(state);
    assert.deepEqual(store.load(), state);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['desktop-state.json', 'unrelated.txt']);
  } finally {
    // Every file here belongs to this test's freshly created temporary directory.
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});
