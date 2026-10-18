// A deliberately conservative, read-only interpreter of Codex rollout records.
// It never evaluates commands or returns message/reasoning/tool-output bodies.
import path from 'node:path';

const STALE_MS = 10 * 60 * 1000;
const MAX_EVENTS = 80;
const MAX_EVIDENCE = 32;

function cleanPath(value) {
  if (typeof value !== 'string') return '';
  let result = value.trim().replace(/^[`'"“]|[`'"”]$/g, '').replace(/\\/g, '/');
  if (/^file:\/\//i.test(result)) {
    try { result = decodeURIComponent(result.replace(/^file:\/\/\/?/i, '')); } catch {}
    if (!/^[a-z]:\//i.test(result)) result = '/' + result.replace(/^\/+/, '');
  }
  result = result.replace(/\/\.\//g, '/').replace(/\/$/, '');
  return result;
}

function pathKey(value) {
  const normalized = cleanPath(value);
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

function resolvePath(value, cwd = '') {
  const normalized = cleanPath(value);
  if (!normalized || /^(?:[a-z]:\/|\/)/i.test(normalized)) return normalized;
  const base = cleanPath(cwd);
  return base ? path.posix.normalize(base + '/' + normalized) : normalized;
}

function isSkillPath(value) { return /(?:^|\/)SKILL\.md$/i.test(cleanPath(value)); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function getText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(x => x && ['input_text', 'output_text', 'Text', 'text'].includes(x.type)).map(x => x.text || '').join('\n');
}
function timestamp(value) {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(number) ? new Date(number).toISOString() : null;
}
function latest(a, b) { return !a || (b && b > a) ? b : a; }
function jsonObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
}

/** Read only the skills catalog, expanding the roots supplied alongside it. */
export function extractAvailableSkills(text) {
  if (typeof text !== 'string') return [];
  const roots = new Map();
  for (const match of text.matchAll(/^\s*-\s*`([^`]+)`\s*=\s*`([^`]+)`\s*$/gm)) roots.set(match[1], cleanPath(match[2]));
  const heading = /^#{1,6}\s+Available skills\s*$/im.exec(text);
  if (!heading) return [];
  let section = text.slice(heading.index + heading[0].length);
  const nextHeading = /^#{1,6}\s+/m.exec(section);
  if (nextHeading) section = section.slice(0, nextHeading.index);
  const skills = new Map();
  for (const match of section.matchAll(/^\s*-\s+(.+?):\s+(.+?)\s+\(file:\s*(.+)\)\s*$/gm)) {
    const name = match[1].trim().replace(/^[*`]+|[*`]+$/g, '');
    let file = cleanPath(match[3]);
    const alias = /^([^/]+)\/(.+)$/.exec(file);
    if (alias && roots.has(alias[1])) file = roots.get(alias[1]) + '/' + alias[2];
    if (!isSkillPath(file)) continue;
    skills.set(pathKey(file), { id: file, name, description: match[2].trim(), path: file });
  }
  return [...skills.values()];
}

// Command text is considered only for completed, successful executions. Matching
// starts at a real shell statement; a mention in echo/rg/reasoning is not a read.
function shellSkillReads(command, cwd) {
  if (typeof command !== 'string') return [];
  const paths = [];
  const statements = [];
  let buffer = '', quote = '', skipPipeline = false, comment = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (comment) {
      if (char === '\n') { statements.push(buffer); buffer = ''; comment = false; skipPipeline = false; }
      continue;
    }
    if (quote) {
      if (!skipPipeline) buffer += char;
      if ((char === '`' || char === '\\') && quote === '"' && i + 1 < command.length) { const escaped = command[++i]; if (!skipPipeline) buffer += escaped; }
      else if (char === quote) {
        if (quote === "'" && command[i + 1] === "'") { i++; if (!skipPipeline) buffer += "'"; }
        else quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") { quote = char; if (!skipPipeline) buffer += char; continue; }
    if (char === '#') { comment = true; continue; }
    if (char === '\n' || char === ';' || (char === '&' && command[i + 1] === '&')) {
      statements.push(buffer); buffer = ''; skipPipeline = false;
      if (char === '&') i++;
      continue;
    }
    if (char === '|') { skipPipeline = true; continue; }
    if (!skipPipeline) buffer += char;
  }
  statements.push(buffer);
  for (const statement of statements) {
    const match = /^\s*(?:Get-Content|cat|gc|type)\b\s+(.+)$/i.exec(statement);
    if (!match) continue;
    const tokens = match[1].match(/'(?:[^']|'')*'|"(?:[^"`]|`.)*"|[^\s|]+/g) || [];
    for (let token of tokens) {
      if (token === '|') break;
      if (token.startsWith('-')) continue;
      token = token.replace(/^['"]|['"]$/g, '').replace(/''/g, "'");
      // Dynamic variables, globs, substitutions, and escaped shell expressions
      // cannot establish a particular file's identity without executing code.
      if (/[$*?`]/.test(token)) continue;
      if (isSkillPath(token)) paths.push(resolvePath(token, cwd));
    }
  }
  return paths;
}

function commandText(command) {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  const index = command.findIndex(x => /^(?:-command|-c|\/c)$/i.test(x));
  return index >= 0 ? command.slice(index + 1).join(' ') : command.join(' ');
}

function completedReadPaths(item, cwd) {
  if (!item || !['CommandExecution', 'command_execution'].includes(item.type)) return [];
  if (item.status !== 'completed' || (item.exit_code ?? item.exitCode) !== 0) return [];
  const paths = (item.parsed_cmd || []).filter(x => x?.type === 'read' && isSkillPath(x.path)).map(x => resolvePath(x.path, cwd));
  return [...new Set([...paths, ...shellSkillReads(commandText(item.command), cwd)])];
}

function declarationNames(text, skills) {
  const stripped = text.replace(/```[\s\S]*?```/g, '').split('\n').filter(line => !/^\s*(?:>|\|)/.test(line)).join('\n');
  const result = [];
  const aliasesBySkill = new Map();
  for (const skill of skills) {
    const short = skill.name.split(':').at(-1);
    const aliases = [skill.name];
    if (short !== skill.name && skills.filter(x => x.name.split(':').at(-1) === short).length === 1) aliases.push(short);
    // Human-friendly "OpenAI Docs" is the same explicit skill name.
    if (short.includes('-')) aliases.push(short.replace(/-/g, ' '));
    aliasesBySkill.set(skill, aliases);
  }
  const anyName = [...aliasesBySkill.values()].flat().map(escapeRegExp).join('|');
  const priorListEntries = '(?:[*`“"\\[]*(?:' + anyName + ')[*`”"\\]]*(?:\\s*,\\s*|\\s+(?:и|and|&)\\s+))*';
  for (const skill of skills) {
    const names = aliasesBySkill.get(skill).map(escapeRegExp).join('|');
    const regex = new RegExp('(?:^|[\\s.!?;:,])(?:я\\s+)?(?:использую|применяю|I(?:\\s+am|[’\']m)?\\s+(?:using|use)|Using)\\s+(?:(?:этот\\s+)?(?:скилл(?:ы|а)?|навык(?:и|а)?|skills?)\\s*:?\\s+)?' + priorListEntries + '[*`“"\\[]*(?:' + names + ')(?![\\p{L}\\p{N}_-])', 'giu');
    for (const match of stripped.matchAll(regex)) {
      const before = stripped.slice(Math.max(0, match.index - 90), match.index).split(/[.!?\n]/).at(-1);
      // Questions, negations, examples, and conditional prose are not declarations.
      const after = stripped.slice(match.index, match.index + match[0].length + 80).split(/[.!\n]/)[0];
      if (/(?:^|\s)(?:не|not|never|если|if|например|example|допустим|suppose|could|would|буду|могу)(?:\s|$)/iu.test(before) || after.includes('?')) continue;
      result.push(skill.id); break;
    }
  }
  return result;
}

/**
 * records: already-parsed JSONL records (invalid/null entries are safely ignored).
 * metadata: SQLite thread row plus optional now (milliseconds, Date, or ISO).
 * Output contains observations and labels only, never raw session contents.
 */
export function parseSessionRecords(records, metadata = {}) {
  const now = timestamp(metadata.now instanceof Date ? metadata.now.toISOString() : metadata.now) || new Date().toISOString();
  const session = {
    id: metadata.id || null, title: metadata.title || '', cwd: metadata.cwd || '',
    model: metadata.model || null, parentId: metadata.parentId || metadata.parent_id || null,
    status: 'unknown', statusSource: 'no-lifecycle-event', currentTurnId: null,
    updatedAt: timestamp(metadata.updated_at_ms ?? metadata.updated_at), lastEventAt: null,
    currentTool: null, skills: [], events: [], availableSnapshotAt: null, availableSource: null,
    availableScope: 'session',
    source: 'local-rollout', archived: Boolean(metadata.archived),
  };
  const skills = new Map();
  const pending = new Map();
  const emitted = new Set();
  const seenMessages = new Set();
  const evidenceKeys = new Set();
  const addEvent = event => { session.events.push(event); if (session.events.length > MAX_EVENTS) session.events.shift(); };
  function applyCatalog(text, at, source, reset = true) {
    if (reset) for (const skill of skills.values()) skill.available = false;
    for (const definition of extractAvailableSkills(text)) {
      const key = pathKey(definition.path);
      const existing = skills.get(key);
      skills.set(key, { ...definition, status: 'available', evidence: [], lastUsedAt: null, loadedAt: null, declaredAt: null, ...existing, ...definition, available: true });
    }
    session.availableSnapshotAt = at;
    session.availableSource = source;
  }
  function observe(file, kind, at, turnId, source) {
    const key = pathKey(resolvePath(file, session.cwd));
    if (!key) return;
    let skill = skills.get(key);
    if (!skill) {
      const normalized = resolvePath(file, session.cwd);
      skill = { id: normalized, path: normalized, name: normalized.split('/').at(-2) || 'skill', description: '', available: false, status: 'available', evidence: [], lastUsedAt: null, loadedAt: null, declaredAt: null };
      skills.set(key, skill);
    }
    // One declaration/read per turn is sufficient; item and response mirrors
    // must not create duplicate evidence or duplicate activity rows.
    const evidenceKey = `${key}|${kind}|${turnId || at}`;
    if (evidenceKeys.has(evidenceKey)) return;
    evidenceKeys.add(evidenceKey);
    const label = kind === 'loaded' ? 'Файл SKILL.md прочитан' : 'Агент сообщил о применении';
    skill.evidence.push({ kind, label, at, turnId, source });
    if (skill.evidence.length > MAX_EVIDENCE) skill.evidence.shift();
    if (kind === 'loaded') skill.loadedAt = latest(skill.loadedAt, at);
    if (kind === 'declared') skill.declaredAt = latest(skill.declaredAt, at);
    skill.lastUsedAt = latest(skill.lastUsedAt, at);
    addEvent({ kind, label: `${skill.name}: ${label.toLowerCase()}`, at, skillId: skill.id, turnId });
  }
  function assistantMessage(content, at, turnId, id) {
    const text = getText(content);
    const key = id || text;
    if (!text || seenMessages.has(key)) return;
    seenMessages.add(key);
    for (const skillId of declarationNames(text, [...skills.values()])) observe(skillId, 'declared', at, turnId, 'assistant-message');
  }
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    const p = record.payload;
    if (!p || typeof p !== 'object') continue;
    const at = timestamp(record.timestamp) || session.lastEventAt;
    session.lastEventAt = latest(session.lastEventAt, at);
    session.updatedAt = latest(session.updatedAt, at);
    const turnId = p.turn_id || session.currentTurnId;
    if (record.type === 'session_meta') {
      session.id ||= p.id || p.session_id || null;
      session.cwd ||= p.cwd || '';
      session.parentId ||= p.parent_thread_id || p.parent_id || p.source?.subagent?.thread_spawn?.parent_thread_id || null;
    } else if (record.type === 'turn_context') {
      session.model = p.model || session.model;
      session.cwd = p.cwd || session.cwd;
      session.currentTurnId = p.turn_id || session.currentTurnId;
    } else if (record.type === 'world_state') {
      const body = p.state?.host_skills?.body;
      if (typeof body === 'string') applyCatalog(body, at, 'world-state');
      else if (p.full === true) applyCatalog('', at, 'world-state');
      const model = p.state?.model;
      if (typeof model === 'string') session.model = model;
      else if (typeof model?.slug === 'string') session.model = model.slug;
    } else if (record.type === 'event_msg') {
      if (['task_started', 'task_complete', 'task_completed', 'turn_aborted'].includes(p.type)) {
        session.status = p.type === 'task_started' ? 'active' : p.type === 'turn_aborted' ? 'interrupted' : 'idle';
        session.statusSource = p.type;
        session.currentTurnId = p.turn_id || session.currentTurnId;
        if (p.type === 'task_started' || session.status !== 'active') pending.clear();
        addEvent({ kind: session.status, label: p.type === 'task_started' ? 'Ход начат' : p.type === 'turn_aborted' ? 'Ход прерван' : 'Ход завершён', at, turnId: session.currentTurnId });
      }
      const item = p.item;
      if (item && p.type === 'item_started' && /(?:ToolCall|CommandExecution|tool_call|command_execution)$/.test(item.type || '')) {
        pending.set(`item:${item.id}`, { name: item.tool || item.name || (item.type === 'CommandExecution' ? 'exec_command' : item.type), startedAt: at });
      }
      if (item && p.type === 'item_completed') {
        pending.delete(`item:${item.id}`);
        if (!emitted.has(item.id || item)) {
          emitted.add(item.id || item);
          for (const file of completedReadPaths(item, session.cwd)) observe(file, 'loaded', at, turnId, 'command-execution');
          if (item.type === 'AgentMessage' && item.phase !== 'analysis') assistantMessage(item.content, at, turnId, item.id);
        }
      }
    } else if (record.type === 'response_item') {
      if (p.type === 'message' && p.role === 'developer') {
        const text = getText(p.content);
        if (/^#{1,6}\s+Available skills\s*$/im.test(text)) applyCatalog(text, at, 'developer-message');
      } else if (p.type === 'message' && p.role === 'assistant' && p.channel !== 'analysis') {
        assistantMessage(p.content, at, turnId, p.id);
      } else if (['function_call', 'custom_tool_call'].includes(p.type)) {
        const args = jsonObject(p.arguments);
        const name = [p.namespace, p.name].filter(Boolean).join('.') || 'tool';
        pending.set(p.call_id || p.id, { name, startedAt: at, args, turnId, toolName: p.name });
      } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        const call = pending.get(p.call_id || p.id);
        pending.delete(p.call_id || p.id);
        if (call) {
          const result = jsonObject(p.output);
          // Fallback for older rollouts with no CommandExecution items. Never
          // mine output text for paths: only the original structured command.
          if (result && result.isError !== true && (result.exit_code ?? result.exitCode) === 0) {
            const cmd = call.args?.cmd || call.args?.command;
            for (const file of shellSkillReads(commandText(cmd), session.cwd)) observe(file, 'loaded', at, call.turnId, 'function-call-output');
          }
        }
      }
    }
  }
  session.title ||= session.id ? `Сессия ${session.id.slice(0, 8)}` : 'Сессия';
  if (session.status === 'active' && (!session.lastEventAt || Date.parse(now) - Date.parse(session.lastEventAt) > STALE_MS)) {
    session.status = 'unknown'; session.statusSource = 'stale-active-event';
  }
  if (session.status === 'active' && pending.size) {
    const newest = [...pending.values()].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))[0];
    session.currentTool = { name: newest.name, startedAt: newest.startedAt };
  }
  session.skills = [...skills.values()].map(skill => ({
    ...skill,
    status: skill.declaredAt ? 'declared' : skill.loadedAt ? 'loaded' : 'available',
    currentTurnLoaded: skill.evidence.some(x => x.kind === 'loaded' && x.turnId === session.currentTurnId),
    currentTurnDeclared: skill.evidence.some(x => x.kind === 'declared' && x.turnId === session.currentTurnId),
  })).filter(skill => skill.available || skill.evidence.length).sort((a, b) => {
    const rank = { declared: 0, loaded: 1, available: 2 };
    return rank[a.status] - rank[b.status] || a.name.localeCompare(b.name);
  });
  return session;
}
