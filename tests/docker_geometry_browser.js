const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const appPort = process.env.KLA_TEST_APP_PORT || '18094';
  const appHost = process.env.KLA_TEST_APP_HOST || '127.0.0.1';
  const debugPort = process.env.KLA_TEST_DEBUG_PORT || '9231';
  const chrome = process.env.KLA_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browserArgs = ['--headless=new', '--no-first-run', '--disable-gpu', '--remote-allow-origins=*',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(os.tmpdir(), `kla-docker-ui-${process.pid}`)}`,
    '--no-proxy-server'];
  if (process.env.KLA_TEST_MAP_HOST_TO_LOOPBACK) browserArgs.push(`--host-resolver-rules=MAP ${appHost} 127.0.0.1`);
  browserArgs.push(`http://${appHost}:${appPort}/`);
  const browser = spawn(chrome, browserArgs, {stdio: ['ignore', 'ignore', 'pipe']});
  let browserError = '';
  browser.stderr.on('data', chunk => { browserError += chunk.toString().slice(0, 2000); });
  try {
    let pages;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(pages, `Headless browser started: ${browserError}`);
    const page = pages.find(item => item.type === 'page' && item.url.includes(`${appHost}:${appPort}/`));
    assert.ok(page, 'Application page opened');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    let sequence = 0;
    socket.onmessage = event => {
      const response = JSON.parse(event.data);
      if (process.env.KLA_TEST_DEBUG) console.error('CDP response', response.id, response.method, response.params?.reason, response.error?.message);
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    };
    socket.onclose = event => { if (process.env.KLA_TEST_DEBUG) console.error('CDP closed', event.code, event.reason); };
    await Promise.race([
      new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DevTools socket timed out')), 5000)),
    ]);
    const evaluate = expression => Promise.race([
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, response => {
          const problem = response.error || response.result?.exceptionDetails;
          if (problem) reject(new Error(JSON.stringify(problem)));
          else resolve(response.result?.result?.value);
        });
        socket.send(JSON.stringify({id, method: 'Runtime.evaluate',
          params: {expression, returnByValue: true, awaitPromise: true}}));
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Evaluate timed out: ${expression.slice(0, 80)}; Chrome: ${browserError}`)), 5000)),
    ]);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const pageStatus = await evaluate(`({url:location.href,title:document.title,
      body:document.body?.innerText.slice(0,160),state:typeof state,
      secure:isSecureContext,randomUUID:typeof crypto.randomUUID,
      getRandomValues:typeof crypto.getRandomValues,
      scripts:[...document.scripts].map(script=>script.src)})`);
    assert.equal(pageStatus.state, 'object', JSON.stringify(pageStatus));
    await evaluate(`(() => {
      window.__pollCounts = {snapshot:0, list:0, active:0, maxActive:0};
      const original = window.fetch;
      window.fetch = async function (...args) {
        const url = String(args[0]);
        if (url === '/api/lidars') __pollCounts.list++;
        if (url.startsWith('/api/lidars/') && url.split('/').length === 4) {
          __pollCounts.snapshot++;
          __pollCounts.active++;
          __pollCounts.maxActive = Math.max(__pollCounts.maxActive, __pollCounts.active);
          try { return await original.apply(this, args); }
          finally { __pollCounts.active--; }
        }
        return original.apply(this, args);
      };
      return true;
    })()`);
    await new Promise(resolve => setTimeout(resolve, 3600));
    const polls = await evaluate('window.__pollCounts');
    assert.ok(polls.snapshot >= 5, JSON.stringify(polls));
    assert.ok(polls.list <= 2, JSON.stringify(polls));
    assert.equal(polls.maxActive, 1, JSON.stringify(polls));
    const setup = await evaluate(`(() => {
      if (!state.config) return {error:'No selected agent'};
      document.querySelector('[data-tab=scene]').click();
      const before = state.config.regions.length;
      document.getElementById('newGeometry').click();
      return {before, menuOpen:!document.getElementById('geometryModal').hidden,
        geometryHandler:typeof document.getElementById('newGeometry').onclick,
        editorLoaded:typeof openEditorModal, secure:isSecureContext,
        randomUUID:typeof crypto.randomUUID, getRandomValues:typeof crypto.getRandomValues};
    })()`);
    assert.equal(setup.menuOpen, true, JSON.stringify(setup));
    await evaluate(`(() => {
      document.getElementById('chooseLine').click();
      state.draft = [[300,0],[300,10]];
      finishDraft();
      return true;
    })()`);
    const geometry = await evaluate(`({count:state.config.regions.length, editorOpen:!geometryEditModal.hidden,
      mode:state.mode, dirty:state.dirty, name:selectedRegion()?.name})`);
    assert.equal(geometry.count, setup.before + 1, JSON.stringify(geometry));
    assert.equal(geometry.editorOpen, true, JSON.stringify(geometry));
    const savedGeometry = await evaluate(`(async () => {
      const ok = await save();
      return {ok, dirty:state.dirty, message:document.getElementById('message').textContent};
    })()`);
    assert.equal(savedGeometry.ok, true, JSON.stringify(savedGeometry));
    const rules = await evaluate(`(() => {
      document.querySelector('[data-tab=rules]').click();
      const before = state.config.rules.length;
      document.getElementById('addRule').click();
      return {before, count:state.config.rules.length, editorOpen:!ruleEditModal.hidden,
        name:selectedRule()?.name};
    })()`);
    assert.equal(rules.count, rules.before + 1, JSON.stringify(rules));
    assert.equal(rules.editorOpen, true, JSON.stringify(rules));
    const savedRule = await evaluate(`(async () => {
      const ok = await save();
      return {ok, dirty:state.dirty, message:document.getElementById('message').textContent};
    })()`);
    assert.equal(savedRule.ok, true, JSON.stringify(savedRule));
    console.log(JSON.stringify({polls, setup, geometry, savedGeometry, rules, savedRule}));
    socket.close();
  } finally { browser.kill(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
