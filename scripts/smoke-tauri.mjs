// End-to-end checks against the real debug Tauri/WebView2 application.
// Node 24+ built-ins only. Profiles and screenshots contain synthetic data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = process.env.SKILL_DESK_APP_BIN
  ? path.resolve(process.env.SKILL_DESK_APP_BIN)
  : path.join(root, 'src-tauri/target/debug/SkillDesk.exe');
const qaRoot = path.resolve(root, '../skill-desk-qa');
const profile = path.join(qaRoot, `tauri-smoke-${Date.now()}-${process.pid}`);
const endpoint = 'http://127.0.0.1:47835';
const checks = [], errors = [], clients = new Set();
let running, fatalError, applicationOutput = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function mark(description) {
  checks.push(description);
  fs.writeFileSync(path.join(profile, 'smoke-progress.json'), JSON.stringify({checks}, null, 2));
  console.log(`PASS ${description}`);
}

async function until(callback, description, timeout = 18000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fatalError) throw fatalError;
    const value = await callback();
    if (value) return value;
    await delay(70);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function targets() {
  const response = await fetch(`${endpoint}/json/list`, {signal: AbortSignal.timeout(1500)});
  if (!response.ok) throw new Error(`CDP discovery HTTP ${response.status}`);
  const value = await response.json();
  assert.ok(Array.isArray(value), 'CDP discovery must return an array.');
  return value.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
}

function widgetId(target) {
  try { return new URL(target.url).searchParams.get('widget'); } catch { return null; }
}

function isApp(target) {
  try {
    const url = new URL(target.url);
    return ['/', '/index.html'].includes(url.pathname) && (url.protocol === 'tauri:' || url.hostname === 'tauri.localhost');
  } catch { return false; }
}

class CDP {
  constructor(socket, label) {
    this.socket = socket;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch (error) { errors.push(`${label}: invalid CDP message: ${error.message}`); return; }
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(`${label}: ${request.method}: ${message.error.message}`));
        else request.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params.exceptionDetails;
        errors.push(`${label}: ${detail.exception?.description || detail.text}`);
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        errors.push(`${label}: ${message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ')}`);
      } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        errors.push(`${label}: ${message.params.entry.text}`);
      }
    });
    socket.addEventListener('close', () => this.rejectPending(new Error(`${label}: CDP connection closed.`)));
    socket.addEventListener('error', () => this.rejectPending(new Error(`${label}: CDP WebSocket failed.`)));
  }

  static async connect(target, label) {
    const url = new URL(target.webSocketDebuggerUrl);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'CDP must stay on loopback.');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {socket.close(); reject(new Error(`${label}: CDP connect timeout.`));}, 8000);
      socket.addEventListener('open', () => {clearTimeout(timer); resolve();}, {once: true});
      socket.addEventListener('error', () => {clearTimeout(timer); reject(new Error(`${label}: CDP connection failed.`));}, {once: true});
    });
    const client = new CDP(socket, label);
    clients.add(client);
    await client.call('Runtime.enable');
    await client.call('Log.enable');
    await client.call('Page.enable');
    await until(() => client.evaluate("document.readyState === 'complete' && typeof window.skillDesk?.getSnapshot === 'function'"), `${label} renderer and native bridge`);
    return client;
  }

  rejectPending(error) {
    for (const request of this.pending.values()) {clearTimeout(request.timer); request.reject(error);}
    this.pending.clear();
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {reject(new Error(`${this.label}: CDP is closed.`)); return;}
      const timer = setTimeout(() => {this.pending.delete(id); reject(new Error(`${this.label}: ${method} timeout.`));}, 10000);
      this.pending.set(id, {resolve, reject, timer, method});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, userGesture: true});
    if (result.exceptionDetails) throw new Error(`${this.label}: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return result.result.value;
  }

  async screenshot(name) {
    // WebView2 can acknowledge DOM changes before its compositor presents them.
    // Let a frame settle before asking CDP for the rendered surface.
    await delay(250);
    const {data} = await this.call('Page.captureScreenshot', {format: 'png', fromSurface: true});
    fs.writeFileSync(path.join(profile, name), Buffer.from(data, 'base64'));
  }

  close() {this.socket.close(); clients.delete(this);}
}

async function click(client, selector) {
  await client.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw Error('Missing control: ' + ${JSON.stringify(selector)}); node.click(); })()`);
}

async function input(client, selector, value) {
  await client.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw Error('Missing input'); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', {bubbles:true})); })()`);
}

function fixture() {
  const home = path.join(profile, 'synthetic-codex');
  fs.mkdirSync(path.join(home, 'sessions'), {recursive: true});
  fs.mkdirSync(path.join(home, 'archived_sessions'));
  const base = Date.now() - 120000;
  const record = (type, payload, offset = 0) => ({type, payload, timestamp: new Date(base + offset).toISOString()});
  const event = (type, turn_id, offset) => record('event_msg', {type, turn_id}, offset);
  const paths = {rust: 'C:/skill-desk-demo/rust-core/SKILL.md', ui: 'C:/skill-desk-demo/ui-preview/SKILL.md'};
  const catalog = record('world_state', {full: true, state: {host_skills: {body: `### Available skills\n- rust-core: Rust backend checks. (file: ${paths.rust})\n- ui-preview: Interface checks. (file: ${paths.ui})\n- pdf:pdf: PDF checks. (file: C:/skill-desk-demo/pdf/SKILL.md)\n`}}}, 1000);
  const read = (skill, id, offset) => record('event_msg', {type:'item_completed', item:{id, type:'CommandExecution', status:'completed', exit_code:0, command:`Get-Content -LiteralPath '${paths[skill]}'`, parsed_cmd:[{type:'read', path:paths[skill]}]}}, offset);
  const rows = [
    ['smoke-active', 'Демонстрация скиллов', [record('session_meta', {id:'smoke-active', cwd:'C:/Demo/Skill Desk'}), event('task_started', 'old-turn', 100), catalog, read('rust', 'old-read', 3000), event('task_complete', 'old-turn', 5000), event('task_started', 'current-turn', 80000), read('ui', 'current-read', 90000)]],
    ['smoke-idle', 'Завершённая сессия', [event('task_started', 'idle-turn', 100), catalog, event('task_complete', 'idle-turn', 5000)]],
    ['smoke-child', 'Проверка субагента', [record('session_meta', {id:'smoke-child', source:{subagent:{thread_spawn:{parent_thread_id:'smoke-active'}}}}), event('task_started', 'child-turn', 100), catalog, event('task_complete', 'child-turn', 5000)]],
  ];
  const dbPath = path.join(home, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT, updated_at INTEGER, updated_at_ms INTEGER, source TEXT, archived INTEGER DEFAULT 0)');
  const insert = db.prepare('INSERT INTO threads(id,rollout_path,title,cwd,updated_at,updated_at_ms,source,archived) VALUES (?,?,?,?,?,?,?,0)');
  for (const [id, title, records] of rows) {
    const journal = path.join(home, 'sessions', `${id}.jsonl`);
    fs.writeFileSync(journal, records.map(row => JSON.stringify(row)).join('\n') + '\n');
    insert.run(id, journal, title, 'C:/Demo/Skill Desk', Math.floor(Date.now()/1000), Date.now(), 'vscode');
  }
  db.close();
  return {home, dbPath, databaseBytes: fs.readFileSync(dbPath), activeJournal: path.join(home, 'sessions/smoke-active.jsonl'), nextRead: () => read('rust', 'live-read', Date.now()-base)};
}

function launch(home) {
  const child = spawn(binary, [], {cwd:root, env:{...process.env, SKILL_DESK_TEST:'1', SKILL_DESK_PROFILE:profile, SKILL_DESK_CODEX_HOME:home}, windowsHide:true, stdio:['ignore','pipe','pipe']});
  const run = {child, exit:null};
  child.on('error', error => {run.exit={code:null, error:error.message};});
  child.on('exit', (code, signal) => {run.exit={code, signal};});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {applicationOutput=(applicationOutput+data.toString()).slice(-24000);});
  running=run;
  return run;
}

async function overviewClient() {
  const target = await until(async () => {
    if (running.exit) throw new Error(`Application exited before UI checks: ${JSON.stringify(running.exit)}\n${applicationOutput}`);
    return (await targets().catch(() => [])).find(target => isApp(target) && !widgetId(target));
  }, 'overview CDP target', 25000);
  return CDP.connect(target, 'overview');
}

async function quit(client) {
  const run = running;
  // Closing the native window can close CDP before the promise reply arrives.
  await client.evaluate("window.skillDesk.windowAction('quit')").catch(error => {
    if (!/CDP|closed|timeout|context/i.test(error.message)) throw error;
  });
  await until(() => run.exit, 'owned application exit', 8000);
  assert.equal(run.exit.code, 0, `Application exit: ${JSON.stringify(run.exit)}`);
  for (const client of [...clients]) client.close();
}

async function run() {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ is required.');
  assert.ok(fs.existsSync(binary), `Build the debug application first: ${binary}`);
  let occupied = false;
  try {await fetch(`${endpoint}/json/list`, {signal:AbortSignal.timeout(1000)}); occupied=true;} catch {}
  assert.equal(occupied, false, 'CDP port 47835 is already occupied; stop the previous debug test before running this script.');
  assert.equal(path.dirname(profile), qaRoot);
  fs.mkdirSync(profile, {recursive:true});
  const data = fixture();
  launch(data.home);
  const overview = await overviewClient();
  assert.equal(await overview.evaluate("typeof window.require + ':' + typeof window.process"), 'undefined:undefined');
  const state = await overview.evaluate('window.skillDesk.getSnapshot()');
  assert.equal(state.source.health, 'ok');
  assert.equal(state.sessions.length, 3);
  assert.deepEqual(state.warnings, []);
  assert.equal(state.window.kind, 'overview');
  await until(() => overview.evaluate("document.querySelectorAll('#session-list [data-session-id]').length === 2 && document.querySelectorAll('#skill-rows tr').length === 3"), 'synthetic sessions and skill table');
  mark('real WebView2 renderer, Rust IPC, isolated SQLite and JSONL data');

  await click(overview, '#session-list [data-session-id="smoke-active"]');
  await until(() => overview.evaluate("document.querySelector('#session-title').textContent === 'Демонстрация скиллов'"), 'active session selection');
  const currentRows = await overview.evaluate("[...document.querySelectorAll('#skill-rows tr')].map(row=>({name:row.dataset.skillName,loaded:row.dataset.loaded,cells:row.cells.length}))");
  assert.ok(currentRows.every(row=>row.cells===2));
  assert.equal(currentRows.find(row=>row.name==='ui-preview').loaded, 'true');
  assert.equal(currentRows.find(row=>row.name==='rust-core').loaded, 'false');
  await click(overview, '#history-toggle');
  assert.equal(await overview.evaluate("document.querySelector('#skill-rows [data-skill-name=\"rust-core\"]').dataset.loaded"), 'true');
  await overview.screenshot('overview-history.png');
  await click(overview, '#current-scope');
  assert.equal(await overview.evaluate("document.querySelector('#skill-rows [data-skill-name=\"rust-core\"]').dataset.loaded"), 'false');
  mark('current-turn and historical skill evidence stay separate');

  await input(overview, '#skill-search', 'no-matching-skill');
  assert.equal(await overview.evaluate("document.querySelectorAll('#skill-rows tr').length === 0 && !document.querySelector('#skills-empty').hidden"), true);
  await input(overview, '#skill-search', 'ui-preview');
  assert.equal(await overview.evaluate("document.querySelectorAll('#skill-rows tr').length"), 1);
  await input(overview, '#skill-search', '');
  await input(overview, '#session-search', 'Завершённая');
  assert.equal(await overview.evaluate("document.querySelectorAll('#session-list [data-session-id]').length"), 1);
  await click(overview, '#session-list [data-session-id="smoke-idle"]');
  assert.equal(await overview.evaluate("document.querySelector('#session-title').textContent"), 'Завершённая сессия');
  await input(overview, '#session-search', '');
  await click(overview, '#session-list [data-session-id="smoke-active"]');
  mark('session selection, session search, matching and empty skill search');

  for (const expression of ["window.skillDesk.setPreferences({theme:'bad'})", "window.skillDesk.openWidget('missing-session')", "window.skillDesk.windowAction('unknown')"]) {
    assert.equal(await overview.evaluate(`${expression}.then(()=>false,()=>true)`), true, `Invalid IPC must reject: ${expression}`);
  }
  mark('invalid preferences, unknown sessions and unknown actions reject');

  const concurrentOpen = await overview.evaluate("Promise.all(Array.from({length:8}, () => window.skillDesk.openWidget('smoke-active')))");
  assert.equal(concurrentOpen.length, 8, 'All concurrent widget requests must complete.');
  const widgetTarget = await until(async () => (await targets()).find(target=>isApp(target)&&widgetId(target)==='smoke-active'), 'widget target');
  assert.equal((await targets()).filter(target=>isApp(target)&&widgetId(target)==='smoke-active').length, 1, 'Eight initial concurrent opens must create one native widget.');
  assert.deepEqual((await overview.evaluate('window.skillDesk.getSnapshot()')).widgets, ['smoke-active']);
  const widget = await CDP.connect(widgetTarget, 'widget');
  await until(() => widget.evaluate("document.body.classList.contains('widget-mode') && document.querySelector('#widget-skill-list').textContent.includes('ui-preview')"), 'widget current skill');
  assert.equal(await widget.evaluate("document.querySelector('#widget-skill-list').textContent.includes('rust-core')"), false);
  await click(overview, '#popout-button');
  await overview.evaluate("window.skillDesk.openWidget('smoke-active')");
  assert.equal((await targets()).filter(target=>isApp(target)&&widgetId(target)==='smoke-active').length, 1);
  assert.equal((await overview.evaluate('window.skillDesk.getSnapshot()')).widgets.length, 1);
  const pin = '.widget-controls [data-focus-key="widget:pin"]';
  assert.equal((await widget.evaluate('window.skillDesk.getSnapshot()')).window.alwaysOnTop, true);
  await click(widget, pin);
  await until(async () => (await widget.evaluate('window.skillDesk.getSnapshot()')).window.alwaysOnTop===false, 'widget unpin');
  assert.equal(await widget.evaluate(`document.querySelector(${JSON.stringify(pin)}).getAttribute('aria-pressed')`), 'false');
  await click(widget, pin);
  await until(async () => (await widget.evaluate('window.skillDesk.getSnapshot()')).window.alwaysOnTop===true, 'widget repin');
  mark('widget rendering, eight concurrent opens, sequential duplicate prevention, native pin and unpin');

  await click(overview, '#settings-button');
  await click(overview, '#theme-button');
  await until(async () => await overview.evaluate("document.documentElement.dataset.theme === 'light'") && await widget.evaluate("document.documentElement.dataset.theme === 'light'"), 'theme broadcast to both windows');
  await click(overview, '#subagents');
  await until(() => overview.evaluate("document.querySelectorAll('#session-list [data-session-id]').length === 3"), 'subagent preference');
  assert.equal((await overview.evaluate('window.skillDesk.getSnapshot()')).preferences.showSubagents, true);
  await click(overview, 'dialog[open] [data-close]');
  assert.equal(await widget.evaluate("document.body.classList.contains('widget-mode') && document.querySelector('#overview').hidden && !document.querySelector('#widget').hidden"), true,
    JSON.stringify(await widget.evaluate("(async()=>({url:location.href,classes:document.body.className,overviewHidden:document.querySelector('#overview').hidden,widgetHidden:document.querySelector('#widget').hidden,window:(await window.skillDesk.getSnapshot()).window}))()")));
  await overview.screenshot('overview-light.png');
  await widget.screenshot('widget-light.png');
  mark('settings dialog, light theme synchronization and subagent toggle');

  fs.appendFileSync(data.activeJournal, JSON.stringify(data.nextRead())+'\n');
  await until(() => widget.evaluate("document.querySelector('#widget-skill-list').textContent.includes('rust-core')"), 'automatic journal update in widget', 12000);
  assert.equal(await overview.evaluate("document.querySelector('#skill-rows [data-skill-name=\"rust-core\"]').dataset.loaded"), 'true');
  mark('three-second Rust polling broadcasts new evidence to both windows');
  assert.deepEqual(errors, [], 'No renderer, CSP, loading or console errors.');

  // Leave the widget open for a graceful restart; both preferences and windows must restore.
  await quit(overview);
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'desktop-state.json'), 'utf8'));
  assert.equal(saved.preferences.theme, 'light');
  assert.equal(saved.preferences.showSubagents, true);
  assert.equal(saved.widgets['smoke-active'].open, true);
  assert.equal(saved.widgets['smoke-active'].alwaysOnTop, true);
  assert.deepEqual(fs.readFileSync(data.dbPath), data.databaseBytes, 'Codex database must remain byte-for-byte unchanged.');
  mark('graceful quit persists preferences and open widget without changing source database');

  launch(data.home);
  const restoredOverview = await overviewClient();
  const restoredWidgetTarget = await until(async () => (await targets()).find(target=>isApp(target)&&widgetId(target)==='smoke-active'), 'restored widget');
  const restoredWidget = await CDP.connect(restoredWidgetTarget, 'restored widget');
  await until(() => restoredOverview.evaluate("document.documentElement.dataset.theme === 'light' && document.querySelector('#subagents').checked"), 'restored preferences');
  assert.equal((await restoredWidget.evaluate('window.skillDesk.getSnapshot()')).window.alwaysOnTop, true);
  await restoredWidget.evaluate("window.skillDesk.windowAction('close')").catch(error=>{if (!/closed|CDP|context|timeout/i.test(error.message)) throw error;});
  await until(async () => !(await restoredOverview.evaluate('window.skillDesk.getSnapshot()')).widgets.includes('smoke-active'), 'restored widget close');
  assert.equal((await targets()).some(target=>isApp(target)&&widgetId(target)==='smoke-active'), false);
  await restoredOverview.evaluate("window.skillDesk.windowAction('close')");
  assert.equal((await restoredOverview.evaluate('window.skillDesk.getSnapshot()')).window.kind, 'overview');
  mark('relaunch restores settings and widget; widget close removes it and overview close preserves tray process');
  assert.deepEqual(errors, [], 'The complete smoke run must have no renderer errors.');
  await quit(restoredOverview);
  const finalSaved = JSON.parse(fs.readFileSync(path.join(profile, 'desktop-state.json'), 'utf8'));
  assert.equal(finalSaved.widgets['smoke-active'].open, false);
  assert.deepEqual(fs.readFileSync(data.dbPath), data.databaseBytes);
  mark('final quit preserves closed-widget state and read-only source access');
}

const timeout = setTimeout(() => {
  fatalError = new Error('Tauri smoke exceeded the 150-second deadline.');
  if (running && !running.exit) running.child.kill();
  for (const client of [...clients]) client.close();
}, 150000);
let ok = false, failure;
try {await run(); ok=true;}
catch (error) {failure=error.stack || String(error); console.error(failure); process.exitCode=1;}
finally {
  clearTimeout(timeout);
  for (const client of [...clients]) client.close();
  // Stop only the child spawned by this script; never enumerate or kill other apps.
  if (running && !running.exit) {
    running.child.kill();
    const deadline=Date.now()+5000;
    while (!running.exit && Date.now()<deadline) await delay(50);
  }
  if (fs.existsSync(profile)) {
    const report={ok, binary, profile, checks, errors, ...(failure?{error:failure}:{}), applicationOutput};
    fs.writeFileSync(path.join(profile, 'smoke-result.json'), JSON.stringify(report,null,2));
  }
  console.log(`SKILL_DESK_TAURI_SMOKE_${ok?'OK':'FAILED'} ${JSON.stringify({profile, checks:checks.length, errors})}`);
}
