const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const port = process.env.KLA_TEST_DEBUG_PORT || '9224';
  const appPort = process.env.KLA_TEST_APP_PORT || '8092';
  const chrome = process.env.KLA_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = spawn(chrome, ['--headless=new', '--no-first-run', '--disable-gpu',
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(os.tmpdir(), `kla-browser-${process.pid}`)}`,
    `http://127.0.0.1:${appPort}/`], {stdio: 'ignore'});
  let pages;
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(pages, 'Headless browser started');
  const page = pages.find(item => item.type === 'page' && item.url.includes(`:${appPort}/`));
  assert.ok(page, 'Test application page is open');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  socket.onmessage = event => {
    const response = JSON.parse(event.data);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const evaluate = expression => new Promise(resolve => {
    const id = ++sequence;
    pending.set(id, result => resolve(result.result?.result?.value ?? result.result?.exceptionDetails));
    socket.send(JSON.stringify({id, method: 'Runtime.evaluate', params: {expression, returnByValue: true, awaitPromise: true}}));
  });
  await new Promise(resolve => setTimeout(resolve, 1500));
  const mapTools = await evaluate('({mode:state.mode,panActive:document.getElementById("pan").classList.contains("active"),zoomButtons:!!document.getElementById("zoomIn")||!!document.getElementById("zoomOut"),leafletZoom:!!document.querySelector(".leaflet-control-zoom")})');
  assert.deepEqual(mapTools, {mode: 'pan', panActive: true, zoomButtons: false, leafletZoom: false});
  const calibrationCheck = await evaluate('(() => { const east=111320*Math.cos(30.4*Math.PI/180), north=111132; const screenshot=[{x:44.397,y:3.116,lat:30.4005376,lon:-84.23316546},{x:73.872,y:12.264,lat:30.4009462,lon:-84.23324525},{x:86.757,y:-4.948,lat:30.4009491,lon:-84.23324123}]; const valid=[{x:0,y:0,lat:30.4,lon:-84.2},{x:10,y:0,lat:30.40009,lon:-84.2},{x:0,y:10,lat:30.4,lon:-84.1999}]; return {issue:referencePairIssue(screenshot,east,north),valid:referencePairIssue(valid,east,north)}; })()');
  assert.match(calibrationCheck.issue, /References 2 and 3 are 21\.5 m apart.*only 0\.5 m apart/);
  assert.equal(calibrationCheck.valid, null);
  const tab = await evaluate('(() => { document.querySelector("[data-tab=integrations]").click(); return {tab:state.tab,visible:!document.getElementById("integrationsPanel").hidden,eventTopic:document.getElementById("mqttEventTopic").value,eventTopicLocked:document.getElementById("mqttEventTopic").disabled}; })()');
  assert.deepEqual(tab, {tab: 'integrations', visible: true, eventTopic: 'events', eventTopicLocked: true});
  const opened = await evaluate('(() => { const before=state.config.integrations.mappings.length; document.getElementById("addIntegration").click(); return {before,count:state.config.integrations.mappings.length,visible:!document.getElementById("integrationModal").hidden}; })()');
  assert.equal(opened.count, opened.before);
  assert.equal(opened.visible, true);
  const cancelled = await evaluate('(() => { document.getElementById("cancelIntegration").click(); return {count:state.config.integrations.mappings.length,hidden:document.getElementById("integrationModal").hidden}; })()');
  assert.equal(cancelled.count, opened.before);
  assert.equal(cancelled.hidden, true);
  const mapping = await evaluate('(() => { document.getElementById("addIntegration").click(); document.getElementById("integrationLocalRule").selectedIndex=1; document.getElementById("integrationExternalRule").selectedIndex=1; document.getElementById("integrationDebounce").value="5"; document.getElementById("integrationForm").requestSubmit(); const last=state.config.integrations.mappings.at(-1); return {count:state.config.integrations.mappings.length,enabled:last.enabled,zone:last.zone,debounce:last.debounce_sec,rows:document.querySelectorAll(".integrationRow").length,hidden:document.getElementById("integrationModal").hidden,badge:document.querySelector(".integrationRow:last-child .integrationState")?.textContent}; })()');
  assert.equal(mapping.count, opened.before + 1);
  assert.equal(mapping.rows, mapping.count);
  assert.equal(mapping.enabled, false);
  assert.equal(mapping.zone, 1);
  assert.equal(mapping.debounce, 5);
  assert.equal(mapping.hidden, true);
  assert.equal(mapping.badge, 'Disabled');
  const enabledBadge = await evaluate('(() => { const last=state.config.integrations.mappings.at(-1); last.enabled=true; renderIntegrationFields(); const badge=document.querySelector(".integrationRow:last-child .integrationState"); const result={text:badge.textContent,styled:badge.classList.contains("isEnabled")}; last.enabled=false; renderIntegrationFields(); return result; })()');
  assert.deepEqual(enabledBadge, {text: 'Enabled', styled: true});
  const edited = await evaluate('(() => { document.querySelector(".integrationRow:last-child .integrationActions button").click(); const visible=!document.getElementById("integrationModal").hidden; const title=document.getElementById("integrationModalTitle").textContent; const debounce=document.getElementById("integrationDebounce").value; document.getElementById("cancelIntegration").click(); return {visible,title,debounce,count:state.config.integrations.mappings.length}; })()');
  assert.deepEqual(edited, {visible: true, title: 'Edit alert mapping', debounce: '5', count: mapping.count});
    socket.close();
    console.log(JSON.stringify({mapTools, calibrationCheck, tab, opened, cancelled, mapping, edited}));
  } finally {
    browser.kill();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
