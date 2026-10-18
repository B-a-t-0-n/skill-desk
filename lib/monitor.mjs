import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseSessionRecords } from './parser.mjs';

const STALE_MS = 10 * 60 * 1000;
const REQUIRED_COLUMNS = ['id', 'rollout_path', 'title', 'cwd', 'updated_at'];
const OPTIONAL_COLUMNS = ['source', 'name', 'model', 'agent_nickname', 'agent_path', 'updated_at_ms', 'archived'];
const clone = value => structuredClone(value);

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function unavailable(session, source = 'journal-unavailable') {
  return { ...clone(session), status: 'unknown', currentTool: null, statusSource: source };
}

function readSlice(fd, start, length) {
  const buffer = Buffer.alloc(length);
  let received = 0;
  while (received < length) {
    const count = fs.readSync(fd, buffer, received, length - received, start + received);
    if (!count) break;
    received += count;
  }
  return buffer.subarray(0, received);
}

/** Local data provider. No HTTP server, model requests, timers, or database writes. */
export function createMonitor({ codexHome, limit = 80 } = {}) {
  const home = path.resolve(codexHome || process.env.SKILL_DESK_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const rowLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(200, Math.floor(Number(limit)))) : 80;
  const roots = ['sessions', 'archived_sessions', 'archive'].map(name => path.join(home, name));
  const cache = new Map();
  let lastState = null;

  function findStateDb() {
    let names;
    try { names = fs.readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name)); }
    catch { throw new Error('Не удалось открыть папку данных Codex.'); }
    names.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!names.length) throw new Error('База сессий Codex не найдена. Откройте локальный чат Codex.');
    return path.join(home, names[0]);
  }

  function allowedFile(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    let file;
    try { file = path.resolve(raw.startsWith('file:') ? fileURLToPath(raw) : raw); }
    catch { return null; }
    const root = roots.find(candidate => inside(candidate, file));
    if (!root || path.extname(file).toLowerCase() !== '.jsonl') return null;
    // The lexical check happens before realpath so a malicious database row
    // cannot make this reader inspect an arbitrary file outside the journals.
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(file);
    return inside(realRoot, realFile) ? realFile : null;
  }

  function readRecords(file) {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not-a-file');
    let entry = cache.get(file);
    const fd = fs.openSync(file, 'r');
    try {
      let reset = !entry || stat.size < entry.offset || stat.ino !== entry.ino || stat.dev !== entry.dev || stat.birthtimeMs !== entry.birthtimeMs;
      if (!reset && stat.size === entry.offset && stat.mtimeMs !== entry.mtimeMs) reset = true;
      if (!reset && stat.size > entry.offset && entry.offset) {
        // Small byte probes detect replacement/truncation followed by a larger
        // rewrite, without rereading a growing journal on every refresh.
        const prefix = readSlice(fd, 0, entry.prefix.length);
        const tail = readSlice(fd, entry.offset - entry.tail.length, entry.tail.length);
        if (!prefix.equals(entry.prefix) || !tail.equals(entry.tail)) reset = true;
      }
      if (reset) entry = { offset: 0, remainder: Buffer.alloc(0), records: [], malformed: 0, parsed: null, metadataKey: null, prefix: Buffer.alloc(0), tail: Buffer.alloc(0) };
      if (stat.size > entry.offset) {
        const bytes = readSlice(fd, entry.offset, stat.size - entry.offset);
        const combined = Buffer.concat([entry.remainder, bytes]);
        const newline = combined.lastIndexOf(10);
        if (newline >= 0) {
          // Decode only complete lines, preserving partial UTF-8 bytes between
          // polls instead of corrupting a character at an append boundary.
          for (const line of combined.subarray(0, newline).toString('utf8').split('\n')) {
            if (!line.trim()) continue;
            try { entry.records.push(JSON.parse(line)); } catch { entry.malformed++; }
          }
          entry.remainder = Buffer.from(combined.subarray(newline + 1));
        } else entry.remainder = Buffer.from(combined);
        entry.offset += bytes.length;
        entry.parsed = null;
        entry.prefix = readSlice(fd, 0, Math.min(128, entry.offset));
        entry.tail = readSlice(fd, Math.max(0, entry.offset - 64), Math.min(64, entry.offset));
      }
      entry.mtimeMs = stat.mtimeMs;
      entry.ino = stat.ino;
      entry.dev = stat.dev;
      entry.birthtimeMs = stat.birthtimeMs;
      cache.set(file, entry);
      return entry;
    } finally { fs.closeSync(fd); }
  }

  function getState() {
    const now = Date.now();
    const warnings = [];
    const info = [];
    let sessions = [];
    let db;
    let health = 'ok';
    let missingJournals = 0, unreadableJournals = 0, rejectedJournals = 0, malformedRecords = 0;
    try {
      db = new DatabaseSync(findStateDb(), { readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(column => column.name));
      const missing = REQUIRED_COLUMNS.filter(column => !columns.has(column));
      if (missing.length) throw new Error('Формат базы Codex изменился: отсутствуют поля ' + missing.join(', ') + '.');
      const selected = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS.filter(column => columns.has(column))];
      const rows = db.prepare(`SELECT ${selected.join(',')} FROM threads ${columns.has('archived') ? 'WHERE archived=0' : ''} ORDER BY updated_at DESC LIMIT ?`).all(rowLimit);
      const usedFiles = new Set();
      const previousById = new Map((lastState?.sessions || []).map(session => [session.id, session]));
      for (const row of rows) {
        let file;
        try {
          file = allowedFile(row.rollout_path);
          if (!file) { rejectedJournals++; continue; }
          usedFiles.add(file);
          const entry = readRecords(file);
          malformedRecords += entry.malformed;
          const metadata = { ...row, title: row.name || row.title };
          const metadataKey = JSON.stringify(metadata);
          if (!entry.parsed || metadataKey !== entry.metadataKey) {
            entry.parsed = parseSessionRecords(entry.records, { ...metadata, now });
            entry.metadataKey = metadataKey;
          }
          const session = clone(entry.parsed);
          if (session.status === 'active' && now - Date.parse(session.lastEventAt || session.updatedAt) > STALE_MS) {
            session.status = 'unknown'; session.statusSource = 'stale-active-event'; session.currentTool = null;
          }
          sessions.push(session);
        } catch (error) {
          if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') missingJournals++;
          else unreadableJournals++;
          const previous = previousById.get(row.id);
          if (previous) sessions.push(unavailable(previous));
        }
      }
      for (const file of cache.keys()) if (!usedFiles.has(file)) cache.delete(file);
      if (missingJournals) info.push(`У ${missingJournals} сессий нет локального журнала: они могли быть удалены или созданы на другом устройстве.`);
      if (rejectedJournals) info.push(`Пропущено журналов вне папки сессий Codex: ${rejectedJournals}.`);
      if (malformedRecords) info.push(`Пропущено повреждённых записей журналов: ${malformedRecords}.`);
      if (unreadableJournals) {
        health = 'partial';
        warnings.push(`Не удалось прочитать журналов: ${unreadableJournals}. Показаны доступные данные.`);
      }
    } catch (error) {
      health = 'error';
      const safeMessage = /^Формат базы Codex|^База сессий Codex|^Не удалось открыть папку данных Codex/.test(error.message || '') ? error.message : 'Не удалось прочитать локальную базу сессий Codex. Данные временно недоступны.';
      warnings.push(safeMessage);
      sessions = (lastState?.sessions || []).map(session => unavailable(session, 'data-source-unavailable'));
    } finally { db?.close(); }
    const state = {
      generatedAt: new Date(now).toISOString(), refreshMs: 3000,
      currentSessionId: process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || null,
      source: {
        mode: 'local-logs', label: 'Локальные журналы Codex', health,
        detail: 'Чтение локальной базы и журналов. Статусы отражают последние записанные события; удалённые чаты без локального журнала не видны.',
        info, missingJournals, unreadableJournals, rejectedJournals, malformedRecords,
      },
      warnings, sessions,
    };
    lastState = clone(state);
    return state;
  }

  return { getState, close() { cache.clear(); lastState = null; } };
}
