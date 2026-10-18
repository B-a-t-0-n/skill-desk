'use strict';

// Entirely synthetic data for public documentation. This module never reads the
// user's Codex profile, database, sessions, environment or filesystem.
const at = '2026-01-01T12:00:00.000Z';
const names = [
  'openai-docs', 'skill-creator', 'skill-installer',
  'computer-use:computer-use', 'imagegen', 'spreadsheet', 'pdf', 'slides'
];

function snapshot(kind = 'overview') {
  const sessionId = 'demo-interface';
  const currentTurnId = 'demo-current-turn';
  const skills = names.map(name => ({id: `demo-skill-${name}`, name, available: true}));
  const evidence = [
    {id: 'demo-read', name: 'openai-docs', kind: 'loaded', at, turnId: currentTurnId},
    {id: 'demo-declaration', name: 'openai-docs', kind: 'declared', at, turnId: currentTurnId},
    {id: 'demo-create', name: 'skill-creator', kind: 'declared', at, turnId: currentTurnId}
  ];
  return {
    generatedAt: at,
    currentSessionId: sessionId,
    refreshMs: 3000,
    preferences: {theme: 'dark', showSubagents: false},
    source: {label: 'Демонстрационные данные', health: 'ok', detail: 'Синтетические сессии для снимков документации.'},
    warnings: [],
    widgets: [],
    window: {kind, sessionId: kind === 'widget' ? sessionId : null, alwaysOnTop: kind === 'widget'},
    sessions: [
      {id: sessionId, title: 'Обновление интерфейса', status: 'active', statusSource: 'Демонстрационный статус', updatedAt: at, currentTurnId, availableSkills: skills, skillEvidence: evidence},
      {id: 'demo-documentation', title: 'Подготовка документации', status: 'active', updatedAt: '2026-01-01T11:30:00.000Z', currentTurnId: 'demo-docs-turn', availableSkills: skills, skillEvidence: []},
      {id: 'demo-release', title: 'Проверка релиза', status: 'idle', updatedAt: '2026-01-01T11:00:00.000Z', currentTurnId: 'demo-release-turn', availableSkills: skills, skillEvidence: []}
    ]
  };
}

module.exports = {snapshot};
