import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAvailableSkills, parseSessionRecords } from '../lib/parser.mjs';

const catalog = `## Skills
### Skill roots
- \`r0\` = \`C:/Users/test/.codex/skills\`
- \`r1\` = \`C:/Some Folder/plugins\`
### Available skills
- openai-docs: Official documentation. (file: r0/openai-docs/SKILL.md)
- pdf:pdf: Read PDFs. (file: r1/pdf/skills/pdf/SKILL.md)
`;
const skillPath = 'C:/Users/test/.codex/skills/openai-docs/SKILL.md';
const now = '2026-10-18T13:05:00Z';
let seq = 0;
const row = (type, payload, at = '2026-10-18T13:00:00Z') => ({ type, payload, timestamp: at });
const start = id => row('event_msg', { type: 'task_started', turn_id: id });
const world = (body = catalog, full = true) => row('world_state', { full, state: { host_skills: { body } } });
const read = (overrides = {}, at = '2026-10-18T13:00:10Z') => row('event_msg', { type: 'item_completed', item: {
  id: `cmd${seq++}`, type: 'CommandExecution', status: 'completed', exit_code: 0,
  command: ['pwsh.exe', '-Command', `Get-Content -LiteralPath '${skillPath}'`],
  parsed_cmd: [{ type: 'read', path: skillPath }], ...overrides,
} }, at);
const message = text => row('response_item', { type: 'message', role: 'assistant', channel: 'commentary', content: [{ type: 'output_text', text }] }, '2026-10-18T13:00:20Z');
const parse = records => parseSessionRecords(records, { id: 'thread-1', title: 'Widget', now });
const find = session => session.skills.find(x => x.name === 'openai-docs');

test('catalog expands aliases, preserves plugin names, descriptions and paths with spaces', () => {
  const skills = extractAvailableSkills(catalog);
  assert.equal(skills.length, 2);
  assert.deepEqual(skills[0], { id: skillPath, name: 'openai-docs', description: 'Official documentation.', path: skillPath });
  assert.equal(skills[1].name, 'pdf:pdf');
  assert.equal(skills[1].path, 'C:/Some Folder/plugins/pdf/skills/pdf/SKILL.md');
  assert.deepEqual(extractAvailableSkills('mention (file: r0/foo/SKILL.md)'), []);
});

test('availability is session evidence and a delta does not erase the catalog', () => {
  const session = parse([world(), row('world_state', { full: false, state: { environments: [] } })]);
  assert.equal(session.skills.length, 2);
  assert.equal(session.availableSource, 'world-state');
  assert.equal(find(session).status, 'available');
});

test('a full replacement clears availability, retaining previously observed reads', () => {
  const session = parse([start('turn-1'), world(), read(), row('world_state', { full: true, state: {} })]);
  assert.equal(session.skills.length, 1);
  assert.equal(find(session).available, false);
  assert.equal(find(session).status, 'loaded');
});

test('a successful real read loads a skill and never exposes tool output', () => {
  const session = parse([start('turn-1'), world(), read({ aggregated_output: 'PRIVATE INSTRUCTIONS' })]);
  const skill = find(session);
  assert.equal(skill.status, 'loaded');
  assert.equal(skill.currentTurnLoaded, true);
  assert.equal(skill.evidence[0].turnId, 'turn-1');
  assert.equal(skill.evidence[0].kind, 'loaded');
  assert.ok(!JSON.stringify(session).includes('PRIVATE'));
});

test('failed, running and interrupted reads do not confirm loading', () => {
  for (const overrides of [{ exit_code: 1 }, { status: 'failed', exit_code: 0 }, { status: 'in_progress' }, { exit_code: null }]) {
    assert.equal(find(parse([world(), read(overrides)])).status, 'available');
  }
});

test('mentions, searches, quoted example commands and output paths do not load skills', () => {
  const commands = [
    `rg 'SKILL.md' '${skillPath}'`,
    `Write-Output 'Get-Content ${skillPath}'`,
    `Write-Output 'example; Get-Content ${skillPath}'`,
    `echo Get-Content ${skillPath}`,
    `Get-Content C:/ordinary.txt | rg '${skillPath}'`,
    `Get-Content C:/ordinary.txt # ${skillPath}`,
  ];
  for (const command of commands) {
    assert.equal(find(parse([world(), read({ command, parsed_cmd: [{ type: 'unknown', cmd: command }], aggregated_output: skillPath })])).status, 'available', command);
  }
});

test('successful batched shell reads and Windows case/slashes map to the catalog', () => {
  const session = parse([world(), read({ parsed_cmd: [{ type: 'unknown' }], command: ['pwsh', '-Command', `Get-Location\nGet-Content -Raw 'c:\\users\\test\\.codex\\skills\\openai-docs\\SKILL.md'\nGet-Date`] })]);
  assert.equal(session.skills.length, 2);
  assert.equal(find(session).status, 'loaded');
});

test('explicit declarations are labeled as agent statements, including friendly skill names', () => {
  for (const text of ['Использую скилл `openai-docs` для проверки.', 'Использую навык OpenAI Docs для проверки.', 'I am using openai-docs for verification.']) {
    const skill = find(parse([start('t'), world(), message(text)]));
    assert.equal(skill.status, 'declared', text);
    assert.equal(skill.evidence[0].label, 'Агент сообщил о применении');
  }
});

test('an explicit list declares each listed skill but a later mention is not part of the list', () => {
  const session = parse([start('t'), world(), message('Использую навыки: `pdf` и `openai-docs` для проверки.')]);
  assert.ok(session.skills.every(x => x.currentTurnDeclared));
  const later = parse([world(), message('Использую pdf для проверки того, доступен ли openai-docs.')]);
  assert.equal(find(later).status, 'available');
});

test('negations, mentions, questions, quotes and reasoning are not declarations', () => {
  for (const text of ['Не использую openai-docs.', 'Я не всегда использую openai-docs.', 'Если необходимо, использую openai-docs.', 'Например использую openai-docs.', 'Можно использовать openai-docs.', 'Использую openai-docs?', '> Использую openai-docs.', '```\nИспользую openai-docs\n```']) {
    assert.equal(find(parse([world(), message(text)])).status, 'available', text);
  }
  const reasoning = row('response_item', { type: 'reasoning', summary: [{ text: 'Использую openai-docs' }] });
  const analysis = row('response_item', { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'Использую openai-docs' }] });
  const interagent = row('response_item', { type: 'agent_message', content: [{ type: 'input_text', text: 'Использую openai-docs' }] });
  assert.equal(find(parse([world(), reasoning, analysis, interagent])).status, 'available');
});

test('historical loading/declaration stays visible but does not imply current turn use', () => {
  const session = parse([start('turn-1'), world(), read(), message('Использую openai-docs.'), row('event_msg', { type: 'task_complete', turn_id: 'turn-1' }), start('turn-2')]);
  assert.equal(find(session).status, 'declared');
  assert.equal(find(session).currentTurnLoaded, false);
  assert.equal(find(session).currentTurnDeclared, false);
  assert.equal(session.status, 'active');
});

test('mirrored item/response reads and declarations produce one observation per turn', () => {
  const call = row('response_item', { type: 'function_call', call_id: 'c', name: 'exec_command', arguments: JSON.stringify({ cmd: `Get-Content '${skillPath}'` }) });
  const output = row('response_item', { type: 'function_call_output', call_id: 'c', output: JSON.stringify({ exit_code: 0, output: 'PRIVATE OUTPUT' }) });
  const session = parse([start('t'), world(), call, read(), output, message('Использую openai-docs.'), message('Использую openai-docs.')]);
  assert.equal(find(session).evidence.length, 2);
  assert.ok(!JSON.stringify(session).includes('PRIVATE'));
  assert.equal(session.currentTool, null);
});

test('only a pending actual call is shown and stale active state becomes unknown', () => {
  const call = row('response_item', { type: 'function_call', call_id: 'c', name: 'exec', namespace: 'functions', arguments: '{}' }, '2026-10-18T13:04:00Z');
  const session = parse([start('t'), call]);
  assert.deepEqual(session.currentTool, { name: 'functions.exec', startedAt: '2026-10-18T13:04:00.000Z' });
  const stale = parseSessionRecords([start('t'), call], { now: '2026-10-18T13:20:00Z' });
  assert.equal(stale.status, 'unknown');
  assert.equal(stale.statusSource, 'stale-active-event');
  assert.equal(stale.currentTool, null);
});

test('lifecycle completion and interruption clear a pending tool', () => {
  for (const [type, status] of [['task_complete', 'idle'], ['turn_aborted', 'interrupted']]) {
    const session = parse([start('t'), row('response_item', { type: 'custom_tool_call', call_id: 'c', name: 'exec', input: 'code' }), row('event_msg', { type, turn_id: 't' })]);
    assert.equal(session.status, status);
    assert.equal(session.currentTool, null);
  }
});

test('developer catalogs are supported; malformed records are ignored safely', () => {
  const session = parse([null, 42, {}, { type: 'event_msg' }, row('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: catalog }] })]);
  assert.equal(session.skills.length, 2);
  assert.equal(session.availableSource, 'developer-message');
  assert.equal(session.status, 'unknown');
});
