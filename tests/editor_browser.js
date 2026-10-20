const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const port = process.env.KLA_EDITOR_TEST_PORT || '18099';
const debugPort = process.env.KLA_EDITOR_DEBUG_PORT || '9236';
const chrome = process.env.KLA_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = path.join(os.tmpdir(), `kla-editor-browser-${process.pid}`);
const browser = spawn(chrome, ['--headless=new', '--no-first-run', '--disable-gpu',
  '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`, '--window-size=1500,900',
  `http://127.0.0.1:${port}/`], {stdio: ['ignore', 'ignore', 'pipe']});
let browserError = '';
browser.stderr.on('data', chunk => { browserError += chunk.toString().slice(0, 2000); });

async function main() {
  try {
    let pages;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(pages, `Chrome did not start: ${browserError}`);
    const page = pages.find(item => item.type === 'page' && item.url.includes(`:${port}/`));
    assert.ok(page, `Test page did not open: ${browserError}`);
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 0;
    socket.onmessage = event => {
      const response = JSON.parse(event.data);
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    };
    await Promise.race([
      new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = reject;
        socket.onclose = () => reject(new Error(`DevTools closed before opening: ${browserError}`));
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`DevTools timed out: ${browserError}`)), 5000)),
    ]);
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out: ${browserError}`));
        }, 5000);
        pending.set(id, response => {
          clearTimeout(timeout);
          const error = response.error || response.result?.exceptionDetails;
          if (error) reject(new Error(JSON.stringify(error)));
          else resolve(response.result);
        });
        socket.send(JSON.stringify({id, method, params}));
      });
    }
    const evaluate = async expression => (await send('Runtime.evaluate',
      {expression, returnByValue: true, awaitPromise: true})).result.value;
    const click = async (x, y) => {
      await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
      await send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
      await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
    };
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await evaluate('typeof state !== "undefined" && Boolean(state.config && state.snapshot)')) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(await evaluate('state.config?.id'), 'editor-test');

    const modal = await evaluate(`(() => {
      document.querySelector('[data-tab="rules"]').click();
      document.querySelector('.ruleRow [aria-label="Edit rule"]').click();
      const box = ruleEditModal.querySelector('.editorModalBox');
      const info = document.querySelector('.headingToolRow .fieldInfo').getBoundingClientRect();
      const button = document.getElementById('headingTool').getBoundingClientRect();
      const check = document.getElementById('headingEnabled').getBoundingClientRect();
      const checkInfo = document.querySelector('#headingEnabled').closest('label').querySelector('.fieldInfo').getBoundingClientRect();
      return {open: !ruleEditModal.hidden, button: {x: button.x, y: button.y, width: button.width, height: button.height},
        info: {x: info.x, y: info.y, width: info.width, height: info.height},
        check: {x: check.x, y: check.y}, checkInfo: {x: checkInfo.x, y: checkInfo.y},
        heading: {x: box.querySelector('h2').getBoundingClientRect().x + 80,
          y: box.querySelector('h2').getBoundingClientRect().y + 12},
        beforeX: box.getBoundingClientRect().x};
    })()`);
    assert.equal(modal.open, true);
    assert.ok(modal.info.width <= 20 && modal.info.x >= modal.button.x + modal.button.width,
      `Heading tooltip is not beside its button: ${JSON.stringify(modal)}`);
    assert.ok(Math.abs(modal.info.y - (modal.button.y + modal.button.height / 2 - modal.info.height / 2)) < 8,
      `Heading tooltip is not vertically centered: ${JSON.stringify(modal)}`);
    assert.ok(modal.checkInfo.x > modal.check.x + 20, 'Heading filter tooltip is not after the label');
    if (process.env.KLA_EDITOR_MODAL_SCREENSHOT) {
      const capture = await send('Page.captureScreenshot', {format: 'png'});
      fs.writeFileSync(process.env.KLA_EDITOR_MODAL_SCREENSHOT, Buffer.from(capture.data, 'base64'));
    }

    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: modal.heading.x, y: modal.heading.y});
    await send('Input.dispatchMouseEvent', {type: 'mousePressed', x: modal.heading.x, y: modal.heading.y,
      button: 'left', clickCount: 1});
    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: modal.heading.x - 80, y: modal.heading.y + 35,
      button: 'left', buttons: 1});
    await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: modal.heading.x - 80,
      y: modal.heading.y + 35, button: 'left', clickCount: 1});
    const movedX = await evaluate('ruleEditModal.querySelector(".editorModalBox").getBoundingClientRect().x');
    assert.ok(movedX < modal.beforeX - 30, `Modal did not move: ${modal.beforeX} -> ${movedX}`);

    const heading = await evaluate(`(() => {
      document.getElementById('headingTool').click();
      const rect = canvas.getBoundingClientRect();
      return {mode:state.mode, modalOpen:!ruleEditModal.hidden,
        transparent:getComputedStyle(ruleEditModal).pointerEvents,
        canvasReachable:document.elementFromPoint(rect.x+50,rect.y+120)===canvas};
    })()`);
    assert.equal(heading.mode, 'heading');
    assert.equal(heading.modalOpen, true);
    assert.equal(heading.transparent, 'none');
    assert.equal(heading.canvasReachable, true);
    const done = await evaluate(`(() => {
      document.getElementById('headingTool').click();
      return {mode:state.mode, modalOpen:!ruleEditModal.hidden};
    })()`);
    assert.deepEqual(done, {mode: 'selectTool', modalOpen: true});
    await evaluate('document.getElementById("headingTool").click()');
    const closed = await evaluate(`(() => {
      ruleEditModal.querySelector('.editorModalActions button').click();
      return {mode:state.mode, hidden:ruleEditModal.hidden};
    })()`);
    assert.deepEqual(closed, {mode: 'selectTool', hidden: true});
    const escaped = await evaluate(`(() => {
      document.querySelector('.ruleRow [aria-label="Edit rule"]').click();
      document.getElementById('headingTool').click();
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
      return {mode:state.mode, hidden:ruleEditModal.hidden};
    })()`);
    assert.equal(escaped.hidden, true);
    assert.notEqual(escaped.mode, 'heading');
    const disabledHeading = await evaluate(`(() => {
      document.querySelector('.ruleRow [aria-label="Edit rule"]').click();
      document.getElementById('headingTool').click();
      const checkbox=document.getElementById('headingEnabled');
      checkbox.checked=false;
      checkbox.dispatchEvent(new Event('change', {bubbles:true}));
      return {mode:state.mode, modalOpen:!ruleEditModal.hidden};
    })()`);
    assert.deepEqual(disabledHeading, {mode: 'selectTool', modalOpen: true});
    await evaluate('ruleEditModal.querySelector(".editorModalActions button").click()');

    const linePoint = await evaluate(`(() => {
      document.querySelector('[data-tab="scene"]').click();
      mode('selectTool');
      const p=screen([10,0]), rect=canvas.getBoundingClientRect(), ratio=devicePixelRatio||1;
      return {x:rect.x+p[0]/ratio,y:rect.y+p[1]/ratio};
    })()`);
    await click(linePoint.x, linePoint.y);
    const selected = await evaluate('({id:state.selectedRegion,modalOpen:!geometryEditModal.hidden})');
    assert.deepEqual(selected, {id: 'line-test', modalOpen: false});
    const vertex = await evaluate(`(() => {
      const p=screen([0,0]), rect=canvas.getBoundingClientRect(), ratio=devicePixelRatio||1;
      return {x:rect.x+p[0]/ratio,y:rect.y+p[1]/ratio};
    })()`);
    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: vertex.x, y: vertex.y});
    await send('Input.dispatchMouseEvent', {type: 'mousePressed', x: vertex.x, y: vertex.y,
      button: 'left', clickCount: 1});
    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: vertex.x + 35, y: vertex.y + 10,
      button: 'left', buttons: 1});
    await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: vertex.x + 35, y: vertex.y + 10,
      button: 'left', clickCount: 1});
    const dragged = await evaluate(`({point:state.config.regions.find(r=>r.id==='line-test').points[0],
      modalOpen:!geometryEditModal.hidden})`);
    assert.ok(dragged.point[0] !== 0 || dragged.point[1] !== 0, JSON.stringify(dragged));
    assert.equal(dragged.modalOpen, false);

    const first = await evaluate(`(() => {
      document.getElementById('newGeometry').click();
      document.getElementById('chooseLine').click();
      const rect=canvas.getBoundingClientRect();
      return {x:rect.x+rect.width*.6,y:rect.y+rect.height*.55};
    })()`);
    await click(first.x, first.y);
    const draft = await evaluate(`(() => {
      const p=screen(state.draft[0]);
      const rgba=[...ctx.getImageData(Math.round(p[0]),Math.round(p[1]),1,1).data];
      return {count:state.draft.length,status:drawStatus.textContent,rgba};
    })()`);
    assert.equal(draft.count, 1);
    assert.ok(draft.status.includes('1/2'), JSON.stringify(draft));
    assert.ok(draft.rgba[0] > 180 && draft.rgba[1] > 120 && draft.rgba[2] < 150,
      `First point marker is not visible: ${JSON.stringify(draft)}`);
    const screenshot = process.env.KLA_EDITOR_SCREENSHOT;
    if (screenshot) {
      const capture = await send('Page.captureScreenshot', {format: 'png'});
      fs.writeFileSync(screenshot, Buffer.from(capture.data, 'base64'));
    }
    const integrationAlerts = await evaluate(`(() => {
      document.querySelector('[data-tab="integrationAlerts"]').click();
      state.snapshot.integration_alerts = [{rule_name:'Crossing',event_id:'00 1234 5678 9012 3456_1793',
        vehicle_id:'00 1234 5678 9012 3456',
        external_rule_name:'Wrong Way',zone:1,topic:'subalert',timestamp:'2026-10-19T12:00:00Z'},
        {rule_name:'Exit Rule',event_id:'confirmation_1793',vehicle_id:'confirmation',
          external_rule_name:'Wrong Way',zone:3,topic:'subalert',timestamp:'2026-10-19T12:00:01Z'}];
      renderIntegrationAlerts();
      const row = document.querySelector('#integrationAlertsList .integrationAlert');
      const identity = row?.querySelector('.integrationAlertIdentity');
      const timing = row?.querySelector('.integrationAlertTiming');
      const result = {visible:!document.getElementById('integrationAlertsPanel').hidden,
        columns:row?.children.length,
        vehicle:identity?.querySelector('strong')?.textContent,
        mapping:identity?.querySelector('small')?.textContent,
        noSubalertId:!row?.textContent.includes('_1793'),
        time:!!timing?.querySelector('time')?.textContent,
        rule:timing?.querySelector('small')?.textContent,
        vehicleFits:identity?.querySelector('strong')?.scrollWidth<=identity?.querySelector('strong')?.clientWidth,
        separated:identity?.getBoundingClientRect().right<=timing?.getBoundingClientRect().left,
        hover:row?.title,
        confirmation:document.querySelectorAll('#integrationAlertsList .integrationAlert')[1]?.querySelector('.integrationAlertIdentity small')?.textContent};
      state.snapshot.integration_alerts = [];
      renderIntegrationAlerts();
      result.empty = document.getElementById('integrationAlertsList').textContent.includes('No generated integration alerts');
      return result;
    })()`);
    assert.deepEqual(integrationAlerts, {visible:true,columns:2,
      vehicle:'00 1234 5678 9012 3456',mapping:'Wrong-way vehicle | Detection Zone',
      noSubalertId:true,time:true,rule:'Crossing',vehicleFits:true,separated:true,
      hover:'External rule: Wrong Way\nZone: 1\nTopic: subalert',
      confirmation:'Wrong-way vehicle | Confirmation Zone',empty:true});
    const integrationActivity = await evaluate(`(async () => {
      const setup = document.getElementById('integrationSetup');
      const collapsed = !setup.open;
      setup.open = true;
      const actions = document.getElementById('integrationConfigActions');
      const buttons = [...actions.querySelectorAll('button')];
      const sameRow = buttons.length === 3 && buttons.every(button =>
        Math.abs(button.getBoundingClientRect().top - buttons[0].getBoundingClientRect().top) < 2 &&
        button.getBoundingClientRect().right <= actions.getBoundingClientRect().right + 1);
      const oldMappings = state.config.integrations.mappings;
      const oldCatalog = state.snapshot.integration_catalog;
      const oldSignals = state.snapshot.integration_signals;
      const oldLive = state.live;
      try {
        state.config.integrations.mappings = [{id:'mapping-ui',enabled:true,zone:1,
          rule_ids:['rule-test'],external_rule_id:'external'}];
        state.snapshot.integration_catalog = {rules:{external:{name:'Wrong Way',lights:[]}},
          devices:{},status:{}};
        state.live = {...(state.live||{}),integration_signals:{last_alerts:{},flasher_remaining_sec:{}}};
        document.querySelector('[data-tab="integrations"]').click();
        updateIntegrationSignals();
        const row = document.querySelector('#integrationList .integrationRow');
        const sign = row.querySelector('.integrationFlasherSign');
        const mappingActions = [...row.querySelectorAll('.integrationActions button')];
        const matchingIcons = mappingActions.length === 2 && mappingActions.every(button =>
          button.classList.contains('iconButton') && !!button.querySelector('svg')) &&
          mappingActions[0].getAttribute('aria-label') === 'Edit alert mapping' &&
          mappingActions[1].getAttribute('aria-label') === 'Delete alert mapping' &&
          mappingActions[1].classList.contains('danger');
        mappingActions[0].click();
        const editOpensModal = !document.getElementById('integrationModal').hidden;
        closeIntegrationModal();
        state.live.integration_signals = {last_alerts:{'mapping-ui':'source-1'},flasher_remaining_sec:{}};
        updateIntegrationSignals();
        const highlighted = row.classList.contains('eventFlash');
        const signBeforeSuccess = !sign.classList.contains('isActive');
        state.live.integration_signals = {last_alerts:{'mapping-ui':'source-1'},
          flasher_remaining_sec:{'mapping-ui':1}};
        updateIntegrationSignals();
        const signActive = sign.classList.contains('isActive') &&
          getComputedStyle(sign).visibility === 'visible' &&
          getComputedStyle(sign).backgroundImage.includes('wrong-way-sign.png');
        const originalNow = Date.now;
        Date.now = () => originalNow() + 1100;
        renderIntegrationActivity();
        const signExpired = !sign.classList.contains('isActive');
        Date.now = originalNow;
        state.snapshot.integration_signals = {observed_at:2,last_alerts:{'mapping-ui':'source-1'},
          flasher_remaining_sec:{}};
        state.live.integration_signals = {observed_at:1,last_alerts:{'mapping-ui':'source-1'},
          flasher_remaining_sec:{'mapping-ui':10}};
        updateIntegrationSignals();
        const staleLiveIgnored = !sign.classList.contains('isActive');
        const asset = await fetch('/wrong-way-sign.png');
        return {collapsed,sameRow,matchingIcons,editOpensModal,highlighted,signBeforeSuccess,signActive,signExpired,staleLiveIgnored,
          assetStatus:asset.status,assetType:asset.headers.get('content-type')};
      } finally {
        state.config.integrations.mappings = oldMappings;
        state.snapshot.integration_catalog = oldCatalog;
        state.snapshot.integration_signals = oldSignals;
        state.live = oldLive;
        setup.open = false;
        integrationActivity.alertUntil.clear();
        integrationActivity.flasherUntil.clear();
        renderIntegrationFields();
      }
    })()`);
    assert.deepEqual(integrationActivity, {collapsed:true,sameRow:true,matchingIcons:true,editOpensModal:true,highlighted:true,
      signBeforeSuccess:true,signActive:true,signExpired:true,staleLiveIgnored:true,
      assetStatus:200,assetType:'image/png'});
    const recentEvents = await evaluate(`(() => {
      document.querySelector('[data-tab="events"]').click();
      state.snapshot.events = [
        {event_id:'event-1',track_id:'96484',class:'car',event_type:'line_crossing',
          direction:'backward',rule_name:'Multi Line Crossing',timestamp:1791474512}
      ];
      state.snapshot.occupancy_events = [
        {event_id:'event-3',rule_id:'occupancy-a',event_type:'occupancy',count:5,
          rule_name:'Passing Zone Occupancy',timestamp:1791474510},
        {event_id:'event-4',rule_id:'occupancy-b',event_type:'occupancy',count:2,
          rule_name:'Waiting Zone Occupancy',timestamp:1791474509}
      ];
      renderEvents();
      const rows = [...document.querySelectorAll('#eventsList .integrationAlert')];
      const identity = rows[0]?.querySelector('.integrationAlertIdentity');
      const timing = rows[0]?.querySelector('.integrationAlertTiming');
      const result = {visible:!document.getElementById('eventsPanel').hidden,
        columns:rows[0]?.children.length,rowCount:rows.length,
        rule:identity?.querySelector('strong')?.textContent,
        ruleColor:identity?.querySelector('strong')&&getComputedStyle(identity.querySelector('strong')).color,
        object:identity?.querySelector('small')?.textContent,
        time:!!timing?.querySelector('time')?.textContent,
        description:timing?.querySelector('small')?.textContent,
        separated:identity?.getBoundingClientRect().right<=timing?.getBoundingClientRect().left,
        occupancy:rows[1]?.querySelector('.integrationAlertIdentity small')?.textContent,
        occupancyTime:rows[1]?.querySelector('time')?.dateTime,
        occupancyRule:rows[1]?.querySelector('.integrationAlertIdentity strong')?.textContent,
        otherOccupancy:rows[2]?.querySelector('.integrationAlertIdentity small')?.textContent};
      state.snapshot.events = [];
      state.snapshot.occupancy_events = [];
      renderEvents();
      result.empty = document.getElementById('eventsList').textContent.includes('No recent events');
      return result;
    })()`);
    assert.deepEqual(recentEvents, {visible:true,columns:2,rowCount:3,rule:'Multi Line Crossing',
      ruleColor:'rgb(255, 213, 79)',object:'Object 96484',
      time:true,description:'Line crossing | backward',
      separated:true,occupancy:'5 objects',
      occupancyTime:new Date(1791474510*1000).toISOString(),
      occupancyRule:'Passing Zone Occupancy',otherOccupancy:'2 objects',empty:true});
    const occupancyHighlight = await evaluate(`(async () => {
      state.occupancyDisplay = new Map();
      state.occupancyInitialized = false;
      state.snapshot.occupancy_events = [{event_id:'occupancy-1',rule_id:'occupancy-a',
        event_type:'occupancy',count:3,rule_name:'Passing Zone Occupancy',timestamp:1791474508}];
      renderEvents();
      const first = document.querySelector('#eventsList .recentEvent');
      const initiallyHighlighted = first.classList.contains('occupancyUpdated');
      state.snapshot.occupancy_events = [{event_id:'occupancy-2',rule_id:'occupancy-a',
        event_type:'occupancy',count:5,rule_name:'Passing Zone Occupancy',timestamp:1791474510}];
      renderEvents();
      const updated = document.querySelector('#eventsList .recentEvent');
      const count = updated.querySelector('.integrationAlertIdentity small');
      const time = updated.querySelector('time');
      const result = {rowCount:document.querySelectorAll('#eventsList .recentEvent').length,
        initiallyHighlighted,highlighted:updated.classList.contains('occupancyUpdated'),
        count:count.textContent,time:time.dateTime,
        countBackground:getComputedStyle(count).backgroundColor,
        timeBackground:getComputedStyle(time).backgroundColor};
      renderEvents();
      result.persistsAcrossRender=document.querySelector('#eventsList .recentEvent').classList.contains('occupancyUpdated');
      state.snapshot.occupancy_events.unshift({event_id:'occupancy-new',rule_id:'occupancy-new',
        event_type:'occupancy',count:1,rule_name:'New Zone Occupancy',timestamp:1791474511});
      renderEvents();
      result.newRuleHighlighted=[...document.querySelectorAll('#eventsList .recentEvent')]
        .find(row=>row.querySelector('strong')?.textContent==='New Zone Occupancy')
        ?.classList.contains('occupancyUpdated');
      await new Promise(resolve=>setTimeout(resolve,1600));
      result.expired=!updated.classList.contains('occupancyUpdated');
      return result;
    })()`);
    assert.deepEqual(occupancyHighlight, {rowCount:1,initiallyHighlighted:false,highlighted:true,
      count:'5 objects',time:new Date(1791474510*1000).toISOString(),
      countBackground:'rgb(255, 213, 79)',timeBackground:'rgb(255, 213, 79)',
      persistsAcrossRender:true,newRuleHighlighted:true,expired:true});
    const canceledToggles = await evaluate(`(async () => {
      const oldConfirm = window.confirm;
      const oldApi = window.api;
      const prompts = [];
      let requests = 0;
      window.confirm = prompt => { prompts.push(prompt); return false; };
      window.api = async () => { requests++; throw Error('Unexpected request'); };
      try {
        const sidebar = document.querySelector('#lidars .agentRow input[type="checkbox"]');
        sidebar.checked = true;
        await setAgentEnabled(state.id,true,sidebar);
        const sidebarRestored = !sidebar.checked;
        sidebar.checked = false;
        await setAgentEnabled(state.id,false,sidebar);
        const disableRestored = sidebar.checked;
        sidebar.checked = false;
        const detail = document.getElementById('enabled');
        detail.checked = true;
        await setAgentEnabled(state.id,true,detail);
        return {sidebarRestored,disableRestored,detailRestored:!detail.checked,requests,prompts};
      } finally { window.confirm = oldConfirm; window.api = oldApi; }
    })()`);
    assert.deepEqual(canceledToggles, {sidebarRestored:true,disableRestored:true,detailRestored:true,requests:0,
      prompts:['Enable Editor Test? Tracking and rule execution will start.',
        'Disable Editor Test? Tracking and rule execution will stop.',
        'Enable Editor Test? Tracking and rule execution will start.']});
    const sensorFilter = await evaluate(`(() => {
      document.querySelector('[data-tab="lidar"]').click();
      const select = document.getElementById('sensorFilterMode');
      select.value = 'object_sensor_id';
      select.dispatchEvent(new Event('change', {bubbles:true}));
      return {visible:!document.getElementById('lidarPanel').hidden,
        mode:state.config.sensor_filter_mode,
        placeholder:document.getElementById('sensorId').placeholder};
    })()`);
    assert.deepEqual(sensorFilter, {visible:true,mode:'object_sensor_id',placeholder:'Required object sensor_id'});
    console.log(JSON.stringify({modalAligned: true, draggable: true, heading, closed, escaped, disabledHeading, selected, dragged, draft, integrationAlerts, integrationActivity, recentEvents, occupancyHighlight, canceledToggles, sensorFilter}));
    socket.close();
  } finally { browser.kill(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
