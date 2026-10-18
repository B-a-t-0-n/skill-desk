'use strict';

// node scripts/capture-docs.cjs
// Renders the actual UI with synthetic data in an isolated, hidden Electron app.
// Never imports electron/main.cjs or the monitor, and never opens live journals.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const profile = path.resolve(root, '../skill-desk-docs-profile');
const output = path.join(root, 'docs/images');

if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const environment = {...process.env};
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {
    cwd: root, env: environment, windowsHide: true, stdio: 'inherit'
  });
  const timer = setTimeout(() => {console.error('Documentation capture timed out.'); child.kill();}, 45000);
  child.on('error', error => {clearTimeout(timer); console.error(error); process.exitCode = 1;});
  child.on('exit', code => {clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1;});
} else {
  const {app, BrowserWindow} = require('electron');
  const {snapshot} = require('./demo-fixture.cjs');
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const errors = [];
  let completed = false;
  app.on('window-all-closed', () => {if (completed) app.quit();});
  async function capture(kind, width, height, filename) {
    const window = new BrowserWindow({
      width, height, useContentSize: true, show: false, frame: false,
      backgroundColor: '#141619',
      webPreferences: {
        preload: path.join(__dirname, 'demo-preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false, offscreen: true,
        additionalArguments: [`--skill-desk-demo=${Buffer.from(JSON.stringify(snapshot(kind))).toString('base64')}`]
      }
    });
    window.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
    window.webContents.on('console-message', details => {if (details.level === 'error') errors.push(details.message);});
    const paints = [];
    window.webContents.on('paint', (_event, _rectangle, image) => paints.push(image.getSize()));
    await window.loadFile(path.join(root, 'ui/index.html'), kind === 'widget' ? {query: {widget: 'demo-interface'}} : {});
    const expected = kind === 'widget' ? 2 : 8;
    const selector = kind === 'widget' ? '#widget .widget-skill' : '#skill-rows tr';
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await window.webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(selector)}).length === ${expected}`)) break;
      await delay(40);
    }
    // A DOM assertion can pass one frame before Chromium composites the change.
    // Wait for fonts, three frames and a real paint before taking the screenshot.
    await window.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    })()`);
    window.webContents.invalidate();
    await delay(400);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(selector)}).length`), expected);
    assert.equal(await window.webContents.executeJavaScript("document.documentElement.dataset.theme"), 'dark');
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.ok(paints.length > 0, 'The screenshot requires at least one composited paint.');
    const body = await window.webContents.executeJavaScript('document.body.innerText');
    for (const label of ['Прочитан', 'Заявлен']) assert.ok(body.includes(label), `Missing demo label: ${label}`);
    if (kind === 'overview') assert.ok(body.includes('Доступен'));
    const image = await window.webContents.capturePage();
    assert.deepEqual(image.getSize(), {width, height});
    fs.writeFileSync(path.join(output, filename), image.toPNG());
    console.log(`Saved docs/images/${filename} (${width}×${height}, synthetic data).`);
    window.destroy();
  }
  app.whenReady().then(async () => {
    fs.mkdirSync(output, {recursive: true});
    await capture('overview', 1100, 790, 'overview.png');
    await capture('widget', 400, 300, 'widget.png');
    assert.deepEqual(errors, [], 'The demo renderer must have no errors.');
    completed = true;
    app.quit();
  }).catch(error => {
    console.error(error);
    completed = true;
    app.exit(1);
  });
}
