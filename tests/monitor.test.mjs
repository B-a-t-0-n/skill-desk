import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createMonitor } from '../lib/monitor.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-desk-test-'));
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions);
  fs.mkdirSync(path.join(home, 'archived_sessions'));
  const dbFile = path.join(home, 'state_5.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT, updated_at INTEGER, updated_at_ms INTEGER, source TEXT, archived INTEGER DEFAULT 0)');
  const monitor = createMonitor({ codexHome: home });
  t.after(() => {
    monitor.close(); db.close();
    const resolved = path.resolve(home);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('skill-desk-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  function add(id, records, extra = {}) {
    const file = extra.file || path.join(sessions, `${id}.jsonl`);
    if (records) fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    db.prepare('INSERT INTO threads(id,rollout_path,title,cwd,updated_at,updated_at_ms,source,archived) VALUES (?,?,?,?,?,?,?,?)').run(id, file, extra.title || 'Пробный чат', home, extra.updated || Math.floor(Date.now() / 1000), Date.now(), 'vscode', extra.archived || 0);
    return file;
  }
  return { home, sessions, dbFile, db, monitor, add };
}
function record(type, payload, at = Date.now()) { return { type, payload, timestamp: new Date(at).toISOString() }; }
function started(id = 't', at = Date.now()) { return record('event_msg', { type: 'task_started', turn_id: id }, at); }
function completed(id = 't', at = Date.now()) { return record('event_msg', { type: 'task_complete', turn_id: id }, at); }
function context(at = Date.now()) { return record('turn_context', { model: 'example-model', turn_id: 't' }, at); }
function catalog() { return record('world_state', { full: true, state: { host_skills: { body: '### Available skills\n- пример: Test skill. (file: C:/skills/пример/SKILL.md)\n' } } }); }

test('reads current local sessions, preserves catalog Unicode and performs no database writes', t => {
  const f = fixture(t);
  f.add('one', [started(), context(), catalog()]);
  const before = fs.readFileSync(f.dbFile);
  const state = f.monitor.getState();
  assert.equal(state.source.health, 'ok');
  assert.deepEqual(state.warnings, []);
  assert.equal(state.sessions[0].status, 'active');
  assert.equal(state.sessions[0].skills[0].name, 'пример');
  assert.equal(state.sessions[0].model, 'example-model');
  assert.deepEqual(fs.readFileSync(f.dbFile), before);
});

test('incremental reader retains partial UTF-8 bytes until a complete newline arrives', t => {
  const f = fixture(t);
  const file = f.add('one', [started()]);
  const bytes = Buffer.from(JSON.stringify(catalog()) + '\n');
  const unicode = bytes.indexOf(Buffer.from('пример'));
  assert.ok(unicode > 0);
  fs.appendFileSync(file, bytes.subarray(0, unicode + 1));
  assert.equal(f.monitor.getState().sessions[0].skills.length, 0);
  fs.appendFileSync(file, bytes.subarray(unicode + 1));
  const state = f.monitor.getState();
  assert.equal(state.sessions[0].skills[0].name, 'пример');
  assert.equal(state.source.malformedRecords, 0);
});

test('a growing journal is read incrementally and an unchanged poll reads no journal bytes', t => {
  const f = fixture(t);
  const large = Array.from({ length: 400 }, (_, n) => record('response_item', { type: 'reasoning', encrypted_content: 'PRIVATE_' + n + 'x'.repeat(400) }));
  const file = f.add('one', [started(), ...large]);
  f.monitor.getState();
  const original = fs.readSync;
  let bytes = 0;
  fs.readSync = function(fd, buffer, offset, length, position) { bytes += length; return original.call(this, fd, buffer, offset, length, position); };
  try {
    f.monitor.getState();
    assert.equal(bytes, 0);
    fs.appendFileSync(file, JSON.stringify(completed()) + '\n');
    const state = f.monitor.getState();
    assert.equal(state.sessions[0].status, 'idle');
    assert.ok(bytes < 1500, `appending a small record reread ${bytes} bytes`);
  } finally { fs.readSync = original; }
});

test('stale active statuses change to unknown even when the journal and cache do not change', t => {
  const f = fixture(t);
  const base = Date.now();
  f.add('one', [started('t', base)]);
  assert.equal(f.monitor.getState().sessions[0].status, 'active');
  const original = Date.now;
  Date.now = () => base + 11 * 60 * 1000;
  try {
    const state = f.monitor.getState();
    assert.equal(state.sessions[0].status, 'unknown');
    assert.equal(state.sessions[0].statusSource, 'stale-active-event');
    assert.equal(state.sessions[0].currentTool, null);
  } finally { Date.now = original; }
});

test('missing historical journals are counted as information without a global error', t => {
  const f = fixture(t);
  f.add('one', [started()]);
  f.add('gone', null);
  f.add('gone-again', null);
  const state = f.monitor.getState();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.source.health, 'ok');
  assert.equal(state.source.missingJournals, 2);
  assert.match(state.source.info[0], /2/);
  assert.deepEqual(state.warnings, []);
});

test('malformed schemas give a clear error and cached statuses become unknown', t => {
  const f = fixture(t);
  f.add('one', [started()]);
  assert.equal(f.monitor.getState().sessions[0].status, 'active');
  f.db.exec('ALTER TABLE threads RENAME COLUMN rollout_path TO changed_path');
  const state = f.monitor.getState();
  assert.equal(state.source.health, 'error');
  assert.match(state.warnings[0], /Формат базы Codex изменился/);
  assert.equal(state.sessions[0].status, 'unknown');
  assert.equal(state.sessions[0].statusSource, 'data-source-unavailable');
});

test('rejects database paths outside the sessions tree without reading those files', t => {
  const f = fixture(t);
  const outside = path.join(f.home, 'private.jsonl');
  f.add('escape', [started(), catalog()], { file: outside });
  const state = f.monitor.getState();
  assert.equal(state.sessions.length, 0);
  assert.equal(state.source.rejectedJournals, 1);
  assert.deepEqual(state.warnings, []);
});

test('archived session tree is allowed while archived database rows stay excluded', t => {
  const f = fixture(t);
  f.add('archived-location', [completed()], { file: path.join(f.home, 'archived_sessions', 'one.jsonl') });
  f.add('hidden', [started()], { archived: 1 });
  const state = f.monitor.getState();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].id, 'archived-location');
});

test('does not expose raw user messages, reasoning, commands or tool output', t => {
  const f = fixture(t);
  f.add('one', [started(), record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE_USER' }] }), record('response_item', { type: 'reasoning', summary: [{ text: 'PRIVATE_REASONING' }] }), record('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'cmd', status: 'completed', exit_code: 0, command: 'Write-Output PRIVATE_COMMAND', aggregated_output: 'PRIVATE_OUTPUT', parsed_cmd: [] } })]);
  assert.ok(!JSON.stringify(f.monitor.getState()).includes('PRIVATE_'));
});

test('detects truncated and replaced journals, and close clears prior cached sessions', t => {
  const f = fixture(t);
  const file = f.add('one', [started(), catalog()]);
  assert.equal(f.monitor.getState().sessions[0].skills.length, 1);
  fs.writeFileSync(file, JSON.stringify(completed()) + '\n');
  assert.equal(f.monitor.getState().sessions[0].skills.length, 0);
  fs.writeFileSync(file, [started(), context(), catalog(), catalog()].map(JSON.stringify).join('\n') + '\n');
  assert.equal(f.monitor.getState().sessions[0].status, 'active');
  f.monitor.close();
  f.db.exec('DROP TABLE threads');
  assert.deepEqual(f.monitor.getState().sessions, []);
});

test('skips malformed complete records without corrupting subsequent valid events', t => {
  const f = fixture(t);
  const file = f.add('one', [started()]);
  fs.appendFileSync(file, '{broken json}\n' + JSON.stringify(completed()) + '\n');
  const state = f.monitor.getState();
  assert.equal(state.sessions[0].status, 'idle');
  assert.equal(state.source.malformedRecords, 1);
  assert.deepEqual(state.warnings, []);
});

test('limit is honored and monitors with an absent database return a data error', t => {
  const f = fixture(t);
  f.add('one', [started()]); f.add('two', [started()]);
  const limited = createMonitor({ codexHome: f.home, limit: 1 });
  assert.equal(limited.getState().sessions.length, 1);
  limited.close();
  const absent = createMonitor({ codexHome: path.join(f.home, 'missing-home') });
  assert.equal(absent.getState().source.health, 'error');
  absent.close();
});
