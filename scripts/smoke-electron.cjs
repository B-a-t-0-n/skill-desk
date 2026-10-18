'use strict';

// Run with `node scripts/smoke-electron.cjs`. The parent launches the installed
// Electron runtime; the child tests the real application in an isolated profile.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const profile = path.resolve(root, '../skill-desk-qa', `electron-smoke-${Date.now()}-${process.pid}`);
  fs.mkdirSync(profile, {recursive: true});
  const environment = {...process.env, SKILL_DESK_TEST: '1', SKILL_DESK_PROFILE: profile};
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, '--electron-run'], {cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let passed = false;
  let output = '';
  child.stdout.on('data', data => {
    output = (output + data.toString()).slice(-16000);
    passed ||= output.includes('SKILL_DESK_SMOKE_OK');
    process.stdout.write(data);
  });
  child.stderr.on('data', data => process.stderr.write(data));
  const timeout = setTimeout(() => {console.error('Electron smoke timed out.'); child.kill();}, 55000);
  child.on('error', error => {clearTimeout(timeout); console.error(error); process.exitCode = 1;});
  child.on('exit', code => {
    clearTimeout(timeout);
    const reportFile = path.join(profile, 'smoke-result.json');
    if (!passed && fs.existsSync(reportFile)) {
      const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      passed = report.ok === true;
      console.log(`SKILL_DESK_SMOKE_${passed ? 'OK' : 'FAILED'} ${JSON.stringify(report)}`);
    }
    process.exitCode = code === 0 && passed ? 0 : 1;
  });
} else {
  const {app, BrowserWindow} = require('electron');
  const errors = [];
  const checks = [];
  let expectedQuit = false;
  let finished = false;
  let sessionCount = 0;
  function mark(description) {
    checks.push(description);
    fs.writeFileSync(path.join(process.env.SKILL_DESK_PROFILE, 'smoke-progress.json'), JSON.stringify({checks}, null, 2));
  }
  assert.equal(process.env.SKILL_DESK_TEST, '1');
  assert.ok(path.isAbsolute(process.env.SKILL_DESK_PROFILE || ''), 'The smoke profile must be absolute.');
  assert.ok(path.resolve(process.env.SKILL_DESK_PROFILE).startsWith(path.resolve(root, '../skill-desk-qa') + path.sep), 'The smoke profile must stay in its QA workspace.');

  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', details => {
      if (details.level === 'error') errors.push(`renderer: ${details.message}`);
    });
    contents.on('preload-error', (_event, _file, error) => errors.push(`preload: ${error.message}`));
    contents.on('did-fail-load', (_event, code, description, url) => {if (code !== -3) errors.push(`load: ${code} ${description} ${url}`);});
    contents.on('render-process-gone', (_event, details) => errors.push(`renderer process: ${details.reason}`));
  });

  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function until(callback, description, timeout = 18000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await callback();
      if (value) return value;
      await delay(35);
    }
    throw new Error(`Timed out waiting for ${description}.`);
  }
  const evaluate = (window, source) => window.webContents.executeJavaScript(source, true);
  async function readyWindow(window) {
    await until(() => !window.webContents.isLoadingMainFrame(), 'renderer load');
    await until(() => evaluate(window, "document.readyState === 'complete' && typeof window.skillDesk?.getSnapshot === 'function'"), 'preload API');
    return window;
  }
  async function click(window, selector) {
    await evaluate(window, `(() => {const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing UI control: ' + ${JSON.stringify(selector)}); element.click();})()`);
  }
  async function input(window, selector, value) {
    await evaluate(window, `(() => {const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing UI input: ' + ${JSON.stringify(selector)}); element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('input', {bubbles:true}));})()`);
  }
  function skillCatalog(session) {
    return (session.availableSkills || (session.skills || []).filter(skill => skill.available !== false)).filter(skill => skill.name);
  }
  function skillSignals(session) {
    return session.skillEvidence || (session.skills || []).flatMap(skill => (skill.evidence || []).map(signal => ({...signal, name: skill.name})));
  }
  function currentSignal(signal, session) {
    return typeof signal.currentTurn === 'boolean' ? signal.currentTurn : Boolean(session.currentTurnId && signal.turnId === session.currentTurnId);
  }
  async function noHorizontalOverflow(window, selectors, label) {
    const geometry = await evaluate(window, `(() => {
      const visible = element => element && element.getClientRects().length > 0;
      return {viewport:innerWidth, documentWidth:document.documentElement.scrollWidth, items:${JSON.stringify(selectors)}.flatMap(selector => [...document.querySelectorAll(selector)].filter(visible).map(element => {const rect=element.getBoundingClientRect();return {selector,left:rect.left,right:rect.right,width:rect.width};}))};
    })()`);
    assert.ok(geometry.documentWidth <= geometry.viewport + 1, `${label}: document must not scroll horizontally: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.items.length > 0, `${label}: layout selectors must identify visible content.`);
    for (const item of geometry.items) {
      assert.ok(item.left >= -1 && item.right <= geometry.viewport + 1, `${label}: content exceeds the viewport: ${JSON.stringify(item)}`);
    }
  }

  async function checkOverviewUi(overview, snapshot) {
    await until(() => evaluate(overview, "!document.getElementById('session-workspace').hidden && document.querySelectorAll('#skill-rows tr').length > 0"), 'selected session skill table');
    const initialId = await evaluate(overview, "document.getElementById('session-workspace').dataset.sessionId");
    const initialSession = snapshot.sessions.find(session => session.id === initialId);
    assert.ok(initialSession, 'The initial workspace must show a real session.');
    assert.ok(await evaluate(overview, "document.querySelector('#session-list [aria-current=true], #session-list [aria-selected=true], #session-list .selected') !== null"), 'The sidebar must identify the selected session.');
    const initialTable = await evaluate(overview, "document.getElementById('skill-rows').textContent");
    const expectedInitial = skillCatalog(initialSession);
    assert.ok(expectedInitial.length > 0, 'The selected real session must have named skills for UI verification.');
    assert.ok(expectedInitial.every(skill => initialTable.includes(skill.name)), 'The table must show every available named skill in the selected session.');
    assert.equal(await evaluate(overview, "Array.from(document.querySelectorAll('#skill-rows tr'), row => row.cells.length).every(count => count === 2)"), true, 'Each skill must have only a name and a plain status column.');
    assert.match(initialTable, /доступен|прочитан|заявлен/i, 'Skill rows must show a readable status.');
    mark('initial session selection and named skill table');

    const secondSession = snapshot.sessions.find(session => !session.parentId && session.id !== initialSession.id && skillCatalog(session).length);
    assert.ok(secondSession, 'The real session list must provide another session for selection.');
    await click(overview, `#session-list [data-session-id="${secondSession.id}"]`);
    await until(() => evaluate(overview, `document.getElementById('session-title').textContent === ${JSON.stringify(secondSession.title)}`), 'session selection');
    const secondTable = await evaluate(overview, "document.getElementById('skill-rows').textContent");
    assert.ok(skillCatalog(secondSession).some(skill => secondTable.includes(skill.name)), 'Changing sessions must update the displayed skill names.');
    mark('sidebar session selection updates workspace');

    const skill = skillCatalog(secondSession)[0];
    await input(overview, '#skill-search', '__skill_desk_smoke_no_such_skill__');
    await until(() => evaluate(overview, "document.getElementById('skill-rows').children.length === 0 && !document.getElementById('skills-empty').hidden"), 'empty skill search');
    assert.match(await evaluate(overview, "document.getElementById('skills-empty').textContent"), /не найден|ничего|нет совпадений/i);
    await input(overview, '#skill-search', skill.name);
    await until(() => evaluate(overview, `document.getElementById('skill-rows').textContent.includes(${JSON.stringify(skill.name)}) && document.getElementById('skills-empty').hidden`), 'matching skill search');
    const matchingRows = await evaluate(overview, "document.querySelectorAll('#skill-rows tr').length");
    assert.ok(matchingRows > 0 && matchingRows < skillCatalog(secondSession).length, 'Skill search must narrow the displayed catalog.');
    await input(overview, '#skill-search', '');
    mark('skill search has useful empty and matching results');

    const historical = snapshot.sessions.find(session => !session.parentId && skillCatalog(session).length && skillSignals(session).some(signal => !currentSignal(signal, session)));
    assert.ok(historical, 'The real sessions must include historical skill signals to verify the scope switch.');
    await click(overview, `#session-list [data-session-id="${historical.id}"]`);
    await until(() => evaluate(overview, `document.getElementById('session-title').textContent === ${JSON.stringify(historical.title)}`), 'historical session selection');
    assert.equal(await evaluate(overview, "document.getElementById('history-toggle').getAttribute('aria-pressed')"), 'false');
    assert.equal(await evaluate(overview, "document.getElementById('current-scope').getAttribute('aria-pressed')"), 'true');
    assert.match(await evaluate(overview, "document.getElementById('current-scope').textContent"), /этот ход|последний ход/i);
    const historicalName = skillSignals(historical).find(signal => !currentSignal(signal, historical))?.name;
    assert.ok(historicalName, 'Historical evidence must identify its skill.');
    const currentSignals = skillSignals(historical).filter(signal => currentSignal(signal, historical));
    const loadedCurrent = new Set(currentSignals.filter(signal => signal.kind === 'loaded').map(signal => signal.name));
    const declaredCurrent = new Set(currentSignals.filter(signal => signal.kind === 'declared').map(signal => signal.name));
    assert.equal(await evaluate(overview, "document.querySelectorAll('#skill-rows tr[data-loaded=true]').length"), loadedCurrent.size, 'Current read marks must exclude past signals.');
    assert.equal(await evaluate(overview, "document.querySelectorAll('#skill-rows tr[data-declared=true]').length"), declaredCurrent.size, 'Current declarations must exclude past signals.');
    assert.equal(await evaluate(overview, "Array.from(document.querySelectorAll('#skill-rows tr[data-loaded=false][data-declared=false]'), row => row.cells[1].textContent).every(status => /доступен/i.test(status))"), true, 'Without current evidence, catalog skills must plainly remain available.');
    await click(overview, '#history-toggle');
    await until(() => evaluate(overview, "document.getElementById('history-toggle').getAttribute('aria-pressed') === 'true' && document.querySelector('#skill-rows tr[data-loaded=true], #skill-rows tr[data-declared=true]') !== null"), 'historical skill statuses');
    assert.equal(await evaluate(overview, "document.getElementById('current-scope').getAttribute('aria-pressed')"), 'false');
    const loadedHistory = new Set(skillSignals(historical).filter(signal => signal.kind === 'loaded').map(signal => signal.name));
    const declaredHistory = new Set(skillSignals(historical).filter(signal => signal.kind === 'declared').map(signal => signal.name));
    assert.equal(await evaluate(overview, "document.querySelectorAll('#skill-rows tr[data-loaded=true]').length"), loadedHistory.size, 'Historical read marks must match the observed named skills.');
    assert.equal(await evaluate(overview, "document.querySelectorAll('#skill-rows tr[data-declared=true]').length"), declaredHistory.size, 'Historical declarations must match the observed named skills.');
    const historyRows = await evaluate(overview, "Array.from(document.querySelectorAll('#skill-rows tr'), row => ({name: row.cells[0].textContent, status: row.cells[1].textContent, loaded: row.dataset.loaded === 'true', declared: row.dataset.declared === 'true'}))");
    assert.ok(historyRows.some(row => row.name.includes(historicalName)), 'The history scope must retain the named historical skill.');
    for (const row of historyRows) {
      if (row.loaded) assert.match(row.status, /прочитан/i, `A read skill must say so: ${row.name}`);
      if (row.declared) assert.match(row.status, /заявлен/i, `A declared skill must say so: ${row.name}`);
    }
    await overview.webContents.capturePage().then(image => fs.writeFileSync(path.join(process.env.SKILL_DESK_PROFILE, 'overview-history.png'), image.toPNG()));
    await click(overview, '#current-scope');
    await until(() => evaluate(overview, "document.getElementById('history-toggle').getAttribute('aria-pressed') === 'false' && document.getElementById('current-scope').getAttribute('aria-pressed') === 'true'"), 'current-turn scope restore');
    mark('current and history scopes filter real skill signals');

    const darkColor = await evaluate(overview, "getComputedStyle(document.body).color");
    await click(overview, '#settings-button');
    await until(() => evaluate(overview, "document.querySelector('dialog[open] #theme-button') !== null"), 'settings dialog');
    await click(overview, '#theme-button');
    await until(() => evaluate(overview, "document.documentElement.dataset.theme === 'light'"), 'light theme control');
    assert.equal((await evaluate(overview, 'window.skillDesk.getSnapshot()')).preferences.theme, 'light');
    assert.notEqual(await evaluate(overview, "getComputedStyle(document.body).color"), darkColor, 'Theme control must change rendered text color.');
    await click(overview, '#theme-button');
    await until(() => evaluate(overview, "document.documentElement.dataset.theme === 'dark'"), 'dark theme restore');
    await click(overview, 'dialog[open] [data-close]');
    await until(() => evaluate(overview, "document.querySelector('dialog[open]') === null"), 'settings dialog close');
    mark('theme control updates native preference and rendered colors');
    await overview.webContents.capturePage().then(image => fs.writeFileSync(path.join(process.env.SKILL_DESK_PROFILE, 'overview-1100.png'), image.toPNG()));

    overview.setSize(660, 790);
    await delay(70);
    assert.equal(overview.getBounds().width, 660);
    await noHorizontalOverflow(overview, ['#overview', '#session-workspace', '#skill-rows tr'], '660px overview');
    await overview.webContents.capturePage().then(image => fs.writeFileSync(path.join(process.env.SKILL_DESK_PROFILE, 'overview-660.png'), image.toPNG()));
    overview.setSize(1100, 790);
    mark('660px overview has no horizontal content overflow');
    const widgetSession = snapshot.sessions.find(session => !session.parentId && skillSignals(session).some(signal => currentSignal(signal, session)));
    assert.ok(widgetSession, 'The real sessions must include a current skill signal for the named widget test.');
    await click(overview, `#session-list [data-session-id="${widgetSession.id}"]`);
    await until(() => evaluate(overview, `document.getElementById('session-workspace').dataset.sessionId === ${JSON.stringify(widgetSession.id)}`), 'current-signal session selection');
    return widgetSession;
  }

  require('../electron/main.cjs');

  app.on('will-quit', () => {
    if (!expectedQuit) {console.error('Application quit before smoke completed.'); process.exitCode = 1; return;}
    try {
      assert.deepEqual(errors, [], 'The renderer must finish without load, preload, or console errors.');
      const saved = JSON.parse(fs.readFileSync(path.join(process.env.SKILL_DESK_PROFILE, 'desktop-state.json'), 'utf8'));
      assert.equal(saved.preferences.theme, 'dark');
      assert.equal(saved.preferences.view, 'grid');
      assert.equal(saved.preferences.showSubagents, false);
      assert.ok(Object.values(saved.widgets).every(widget => widget.open === false));
      mark('quit IPC and persisted profile');
      const report = {ok: true, electron: process.versions.electron, sessionCount, checks};
      fs.writeFileSync(path.join(process.env.SKILL_DESK_PROFILE, 'smoke-result.json'), JSON.stringify(report, null, 2));
      console.log(`SKILL_DESK_SMOKE_OK ${JSON.stringify(report)}`);
      finished = true;
    } catch (error) {console.error(error.stack); process.exitCode = 1;}
  });

  (async () => {
    await app.whenReady();
    const overview = await until(() => BrowserWindow.getAllWindows().find(window => window.__skillSessionId === null), 'overview window');
    await readyWindow(overview);
    assert.equal(overview.isVisible(), false, 'Test mode must not automatically show windows.');
    assert.equal(overview.isDestroyed(), false);
    const settings = overview.webContents.getLastWebPreferences();
    assert.equal(settings.contextIsolation, true);
    assert.equal(settings.sandbox, true);
    assert.equal(settings.nodeIntegration, false);
    assert.equal(await evaluate(overview, "typeof window.require + ':' + typeof window.process"), 'undefined:undefined');
    mark('renderer load, sandbox, context isolation, preload');

    const snapshot = await evaluate(overview, 'window.skillDesk.getSnapshot()');
    assert.equal(snapshot.desktop, true);
    assert.equal(snapshot.window.kind, 'overview');
    assert.equal(snapshot.source.mode, 'local-logs');
    assert.ok(snapshot.sessions.length > 0, 'The real local Codex database must contain sessions.');
    assert.equal(snapshot.error, undefined);
    sessionCount = snapshot.sessions.length;
    mark('real local sessions via preload IPC');

    await evaluate(overview, "window.__smokeUpdates = []; window.__smokeUnsubscribe = window.skillDesk.onUpdate(state => window.__smokeUpdates.push(state.preferences.theme)); void 0;");
    const preferences = await evaluate(overview, "window.skillDesk.setPreferences({theme:'light',view:'list',showSubagents:true})");
    assert.deepEqual(preferences.preferences, {theme: 'light', view: 'list', showSubagents: true});
    await until(() => evaluate(overview, "window.__smokeUpdates.includes('light')"), 'preferences update broadcast');
    const rejected = await evaluate(overview, "window.skillDesk.setPreferences({theme:'invalid'}).then(() => false, () => true)");
    assert.equal(rejected, true);
    await evaluate(overview, "window.skillDesk.setPreferences({theme:'dark',view:'grid',showSubagents:false})");
    mark('preferences validation, persistence and update events');

    const selectedForWidget = await checkOverviewUi(overview, snapshot);
    const id = selectedForWidget.id;
    const afterOpen = await evaluate(overview, `window.skillDesk.openWidget(${JSON.stringify(id)})`);
    assert.ok(afterOpen.widgets.includes(id));
    const widget = await until(() => BrowserWindow.getAllWindows().find(window => window.__skillSessionId === id), 'session widget');
    await readyWindow(widget);
    const widgetSnapshot = await evaluate(widget, 'window.skillDesk.getSnapshot()');
    assert.equal(widgetSnapshot.window.kind, 'widget');
    assert.equal(widgetSnapshot.window.sessionId, id);
    assert.equal(widget.isVisible(), false);
    assert.equal(widget.isAlwaysOnTop(), true);
    const unpinned = await evaluate(widget, 'window.skillDesk.setAlwaysOnTop(false)');
    assert.equal(unpinned.window.alwaysOnTop, false);
    assert.equal(widget.isAlwaysOnTop(), false);
    await evaluate(widget, 'window.skillDesk.setAlwaysOnTop(true)');
    assert.equal(widget.isAlwaysOnTop(), true);
    mark('session widget IPC and always-on-top');

    await until(() => evaluate(widget, "document.querySelectorAll('#widget .widget-skill-name').length > 0"), 'widget skill names');
    const widgetNames = await evaluate(widget, "Array.from(document.querySelectorAll('#widget .widget-skill-name'), element => element.textContent)");
    const currentNames = new Set(skillSignals(selectedForWidget).filter(signal => currentSignal(signal, selectedForWidget)).map(signal => signal.name));
    assert.ok(widgetNames.length > 0 && widgetNames.every(name => currentNames.has(name)), 'The widget must show actual skill names observed in the current turn.');
    assert.equal(await evaluate(widget, "document.querySelector('#widget .skill-rail, #widget .pipeline-rail') !== null"), false, 'The skill widget must not render a pipeline rail.');
    await widget.webContents.capturePage().then(image => fs.writeFileSync(path.join(process.env.SKILL_DESK_PROFILE, 'widget-default.png'), image.toPNG()));
    widget.setSize(330, 360);
    await delay(70);
    assert.equal(widget.getBounds().width, 330);
    await noHorizontalOverflow(widget, ['#widget', '#widget > *', '#widget .widget-skill'], '330px widget');
    await widget.webContents.capturePage().then(image => fs.writeFileSync(path.join(process.env.SKILL_DESK_PROFILE, 'widget-330.png'), image.toPNG()));
    mark('330px widget shows real skill names without horizontal overflow');

    // Destroying a renderer may leave executeJavaScript's return promise pending.
    // Observe the native close event rather than waiting for a destroyed world.
    evaluate(widget, "window.skillDesk.windowAction('close')").catch(error => {if (!widget.isDestroyed()) errors.push(`close IPC: ${error.message}`);});
    await until(() => widget.isDestroyed(), 'widget close');
    const afterClose = await evaluate(overview, 'window.skillDesk.getSnapshot()');
    assert.equal(afterClose.widgets.includes(id), false);
    mark('widget close removes restored widget');

    // The test explicitly shows the window briefly to prove close really hides it.
    overview.showInactive();
    assert.equal(overview.isVisible(), true);
    await evaluate(overview, "window.skillDesk.windowAction('close')");
    await until(() => !overview.isVisible(), 'overview hide to tray');
    assert.equal(overview.isDestroyed(), false);
    await evaluate(overview, 'window.__smokeUnsubscribe()');
    mark('overview close hides to tray');
    assert.deepEqual(errors, []);

    expectedQuit = true;
    try {await evaluate(overview, "window.skillDesk.windowAction('quit')");}
    catch (error) {if (!expectedQuit || (!finished && !overview.isDestroyed())) throw error;}
  })().catch(error => {
    fs.writeFileSync(path.join(process.env.SKILL_DESK_PROFILE, 'smoke-result.json'), JSON.stringify({ok: false, checks, errors, error: error.stack || String(error)}, null, 2));
    console.error('SKILL_DESK_SMOKE_FAILED', error.stack || error);
    if (errors.length) console.error(JSON.stringify(errors, null, 2));
    app.exit(1);
  });
}
