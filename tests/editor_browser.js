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
    console.log(JSON.stringify({modalAligned: true, draggable: true, heading, closed, escaped, disabledHeading, selected, dragged, draft}));
    socket.close();
  } finally { browser.kill(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
