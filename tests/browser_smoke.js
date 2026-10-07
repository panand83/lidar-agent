const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  if (process.argv.includes('--close')) {
    const browser = await (await fetch('http://127.0.0.1:9223/json/version')).json();
    const socket = new WebSocket(browser.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.send(JSON.stringify({id: 1, method: 'Browser.close'}));
    return;
  }
  const pages = await (await fetch('http://127.0.0.1:9223/json')).json();
  const page = pages.find(item => item.type === 'page' && item.url.includes('8091'));
  assert.ok(page, 'Local app page is open in Chrome');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  socket.onmessage = event => {
    const reply = JSON.parse(event.data);
    if (!pending.has(reply.id)) return;
    pending.get(reply.id)(reply);
    pending.delete(reply.id);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  function evaluate(expression) {
    return new Promise(resolve => {
      const id = nextId++;
      pending.set(id, reply => resolve(reply.result?.result?.value ?? reply.result?.exceptionDetails));
      socket.send(JSON.stringify({id, method: 'Runtime.evaluate', params: {expression, returnByValue: true}}));
    });
  }
  function dispatch(method, params) {
    return new Promise(resolve => {
      const id = nextId++;
      pending.set(id, reply => resolve(reply.result));
      socket.send(JSON.stringify({id, method, params}));
    });
  }
  await dispatch('Emulation.setDeviceMetricsOverride', {width: 1400, height: 900, deviceScaleFactor: 1, mobile: false});
  await evaluate('location.reload(); true');
  await new Promise(resolve => setTimeout(resolve, 2500));
  const initial = await evaluate('({scene:document.getElementById("scenePanel").hidden,geometry:document.getElementById("geometryPanel").hidden,tab:state.tab,override:String(setTab).includes("kyraSetTab"),editor:typeof renderGeometryList})');
  assert.equal(initial.scene, true);
  assert.equal(initial.geometry, false);
  assert.equal(initial.override, true);
  const initialMap = await evaluate('({mode:state.mode,panActive:document.getElementById("pan").classList.contains("active"),zoomButtons:!!document.getElementById("zoomIn")||!!document.getElementById("zoomOut"),leafletZoom:!!document.querySelector(".leaflet-control-zoom")})');
  assert.deepEqual(initialMap, {mode:'pan',panActive:true,zoomButtons:false,leafletZoom:false});
  const mapFilters = await evaluate('(() => { const original=state.snapshot.tracks; state.snapshot.tracks=[{id:"car",class:"car",points:[[0,0]]},{id:"truck",class:"truck",points:[[1,1]]},{id:"person",class:"person",points:[[2,2]]},{id:"human",class:"human",points:[[3,3]]},{id:"unknown",class:"other",points:[[4,4]]}]; const all=visibleTracks().map(track=>track.id); document.getElementById("showVehicles").click(); const noVehicles=visibleTracks().map(track=>track.id); document.getElementById("showHumans").click(); const otherOnly=visibleTracks().map(track=>track.id); document.getElementById("showOther").click(); const none=visibleTracks().length; for(const id of ["showVehicles","showHumans","showOther"])document.getElementById(id).click(); const preserved=state.snapshot.tracks.length; state.snapshot.tracks=original; renderCanvas(); return {all,noVehicles,otherOnly,none,preserved}; })()');
  assert.deepEqual(mapFilters, {all:['car','truck'],noVehicles:[],otherOnly:['person','human'],none:3,preserved:5});
  const zoneDirection = await evaluate('(() => { document.querySelector("[data-tab=rules]").click(); const rule=state.config.rules.find(item=>item.type==="zone_transition"); state.selectedRule=rule.id; state.ruleEditorOpen=true; renderFields(); return {value:document.getElementById("ruleDirection").value,options:[...document.getElementById("ruleDirection").options].map(option=>option.value),enabled:rule.enabled}; })()');
  assert.deepEqual(zoneDirection.options, ['any', 'entering', 'leaving', 'both']);
  const occupancyControls = await evaluate('(() => { const rule=state.config.rules.find(item=>item.type==="zone_transition"); const copy={...rule,id:"browser-occupancy",type:"occupancy"}; state.config.rules.push(copy); state.selectedRule=copy.id; renderFields(); const result={headingHidden:getComputedStyle(document.getElementById("headingEnabled").closest("label")).display==="none",speedHidden:getComputedStyle(document.getElementById("minSpeed").closest("label")).display==="none",directionHidden:getComputedStyle(document.getElementById("ruleDirection").closest("label")).display==="none"}; state.config.rules.pop(); state.selectedRule=rule.id; renderFields(); return result; })()');
  assert.equal(occupancyControls.headingHidden, true);
  assert.equal(occupancyControls.speedHidden, true);
  assert.equal(occupancyControls.directionHidden, true);
  await evaluate('document.querySelector("[data-tab=scene]").click(); true');
  const beforeZoom = await evaluate('backgroundMap.getZoom()');
  await evaluate('zoomMap(-1); true');
  await new Promise(resolve => setTimeout(resolve, 500));
  const afterZoom = await evaluate('backgroundMap.getZoom()');
  await evaluate('zoomMap(1); true');
  await new Promise(resolve => setTimeout(resolve, 500));
  const zoom = {before: beforeZoom, after: afterZoom, restored: await evaluate('backgroundMap.getZoom()')};
  assert.equal(zoom.after, zoom.before - 1);
  assert.equal(zoom.restored, zoom.before);
  const editing = await evaluate('(() => { document.querySelector("[data-tab=scene]").click(); document.querySelector("#geometryList .iconButton").click(); const region=selectedRegion(); const a=screen(region.points[0]), b=screen(region.points[1]), rect=canvas.getBoundingClientRect(), ratio=devicePixelRatio||1; return {mode:state.mode, pointerEvents:canvas.style.pointerEvents, id:region.id, before:region.points.map(p=>[...p]), x:rect.left+(a[0]+b[0])/(2*ratio), y:rect.top+(a[1]+b[1])/(2*ratio)}; })()');
  console.log('editing', JSON.stringify(editing));
  assert.equal(editing.mode, 'selectTool');
  assert.equal(editing.pointerEvents, 'auto');
  await dispatch('Input.dispatchMouseEvent', {type:'mousePressed', x:editing.x, y:editing.y, button:'left', clickCount:1});
  await dispatch('Input.dispatchMouseEvent', {type:'mouseMoved', x:editing.x+25, y:editing.y+15, button:'left', buttons:1});
  await dispatch('Input.dispatchMouseEvent', {type:'mouseReleased', x:editing.x+25, y:editing.y+15, button:'left', clickCount:1});
  const dragged = await evaluate('({points:selectedRegion().points,dirty:state.dirty})');
  assert.notDeepEqual(dragged.points, editing.before);
  assert.equal(dragged.dirty, true);
  const redrawn = await evaluate('(() => { const id=selectedRegion().id; document.getElementById("redrawGeometry").click(); state.draft=[[1,1],[2,2]]; finishDraft(); return {id:selectedRegion().id,points:selectedRegion().points,mode:state.mode}; })()');
  assert.equal(redrawn.id, editing.id);
  assert.deepEqual(redrawn.points, [[1,1],[2,2]]);
  assert.equal(redrawn.mode, 'selectTool');
  await evaluate('location.reload(); true');
  await new Promise(resolve => setTimeout(resolve, 1500));
  const drawStart = await evaluate('(() => { const count=state.config.regions.length; document.getElementById("newGeometry").click(); document.getElementById("chooseLine").click(); return {count,mode:state.mode,selected:state.selectedRegion,pointerEvents:canvas.style.pointerEvents,oldEditorHidden:document.getElementById("geometryEdit").hidden}; })()');
  assert.equal(drawStart.mode, 'drawLine');
  assert.equal(drawStart.selected, null);
  assert.equal(drawStart.pointerEvents, 'auto');
  assert.equal(drawStart.oldEditorHidden, true);
  for (const [x, y] of [[390, 500], [470, 530]]) {
    await dispatch('Input.dispatchMouseEvent', {type:'mousePressed', x, y, button:'left', clickCount:1});
    await dispatch('Input.dispatchMouseEvent', {type:'mouseReleased', x, y, button:'left', clickCount:1});
  }
  const drawn = await evaluate('({count:state.config.regions.length,mode:state.mode,points:selectedRegion()?.points,editorOpen:!document.getElementById("geometryEdit").hidden})');
  assert.equal(drawn.count, drawStart.count + 1);
  assert.equal(drawn.mode, 'selectTool');
  assert.equal(drawn.points.length, 2);
  assert.equal(drawn.editorOpen, true);
  await evaluate('location.reload(); true');
  await new Promise(resolve => setTimeout(resolve, 1500));
  const created = await evaluate('(() => { document.getElementById("newGeometry").click(); const modalOpen = !document.getElementById("geometryModal").hidden; document.getElementById("chooseLine").click(); state.draft = [[0,0],[0,10]]; finishDraft(); return {modalOpen, mode:state.mode, name:selectedRegion()?.name, editorOpen:!document.getElementById("geometryEdit").hidden, count:state.config.regions.length}; })()');
  assert.equal(created.modalOpen, true);
  assert.match(created.name, /^Line \d+$/);
  assert.equal(created.mode, 'selectTool');
  assert.equal(created.editorOpen, true);
  const ruled = await evaluate('(() => { document.querySelector("[data-tab=rules]").click(); document.getElementById("addRule").click(); const rule = selectedRule(); return {type:rule.type, line1:document.getElementById("ruleLine1").value, editorOpen:!document.getElementById("ruleEdit").hidden, listCount:document.getElementById("ruleList").children.length}; })()');
  assert.equal(ruled.type, 'line_crossing');
  assert.equal(ruled.editorOpen, true);
  assert.ok(ruled.line1);
  assert.deepEqual(await evaluate('selectedRule().class_filter'), ['car']);
  const converted = await evaluate('(() => { document.getElementById("ruleType").value="occupancy"; document.getElementById("ruleType").dispatchEvent(new Event("change",{bubbles:true})); const rule=selectedRule(); return {type:rule.type,classes:rule.class_filter,hasHeading:Object.hasOwn(rule,"heading_enabled"),hasSpeed:Object.hasOwn(rule,"min_speed_mps"),hasSequence:Object.hasOwn(rule,"line_trigger_mode"),interval:rule.publish_interval_ms}; })()');
  assert.equal(converted.type, 'occupancy');
  assert.deepEqual(converted.classes, ['car']);
  assert.equal(converted.hasHeading, false);
  assert.equal(converted.hasSpeed, false);
  assert.equal(converted.hasSequence, false);
  assert.equal(converted.interval, 500);
  const headingStart = await evaluate('(() => { const rule=state.config.rules.find(item=>item.type==="line_crossing"); rule.heading_enabled=true; rule.heading_center_deg=90; rule.heading_deviation_deg=45; rule.heading_anchor=world([canvas.width/2,canvas.height/2]); state.selectedRule=rule.id; state.ruleEditorOpen=true; document.querySelector("[data-tab=rules]").click(); dirty(); renderFields(); document.getElementById("headingTool").click(); const center=screen(rule.heading_anchor),rect=canvas.getBoundingClientRect(),ratio=devicePixelRatio||1; return {mode:state.mode,x:rect.left+center[0]/ratio,y:rect.top+center[1]/ratio,heading:rule.heading_center_deg,deviation:rule.heading_deviation_deg}; })()');
  assert.equal(headingStart.mode, 'heading');
  if (process.argv.includes('--heading-screenshot')) {
    const screenshot = await dispatch('Page.captureScreenshot', {format:'png', captureBeyondViewport:false});
    fs.writeFileSync(path.join(__dirname, '..', 'heading-check.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await dispatch('Input.dispatchMouseEvent', {type:'mousePressed',x:headingStart.x-75,y:headingStart.y,button:'left',clickCount:1});
  await dispatch('Input.dispatchMouseEvent', {type:'mouseMoved',x:headingStart.x,y:headingStart.y-75,button:'left',buttons:1});
  await dispatch('Input.dispatchMouseEvent', {type:'mouseReleased',x:headingStart.x,y:headingStart.y-75,button:'left',clickCount:1});
  const headingTurned = await evaluate('selectedRule().heading_center_deg');
  assert.ok(Math.abs(headingTurned-180)<1, `heading changed to ${headingTurned}`);
  await dispatch('Input.dispatchMouseEvent', {type:'mouseWheel',x:headingStart.x,y:headingStart.y,deltaX:0,deltaY:-120});
  const headingSpread = await evaluate('selectedRule().heading_deviation_deg');
  assert.equal(headingSpread, 49);
  await dispatch('Input.dispatchMouseEvent', {type:'mousePressed',x:headingStart.x,y:headingStart.y,button:'left',clickCount:1});
  await dispatch('Input.dispatchMouseEvent', {type:'mouseMoved',x:headingStart.x+35,y:headingStart.y+20,button:'left',buttons:1});
  await dispatch('Input.dispatchMouseEvent', {type:'mouseReleased',x:headingStart.x+35,y:headingStart.y+20,button:'left',clickCount:1});
  const movedAnchor = await evaluate('(() => { const p=screen(selectedRule().heading_anchor),r=canvas.getBoundingClientRect(),ratio=devicePixelRatio||1; return [r.left+p[0]/ratio,r.top+p[1]/ratio]; })()');
  assert.ok(Math.hypot(movedAnchor[0]-headingStart.x-35,movedAnchor[1]-headingStart.y-20)<2);
  const fresh = await evaluate('(() => { state.config=structuredClone(state.config); state.config.regions=[]; state.config.rules=[]; state.config.map_alignment.geo=null; clean(); mode("pan"); setTab("scene"); document.getElementById("newGeometry").click(); const modalOpen=!document.getElementById("geometryModal").hidden; document.getElementById("chooseLine").click(); return {modalOpen,mode:state.mode,pointerEvents:canvas.style.pointerEvents}; })()');
  assert.equal(fresh.modalOpen, true);
  assert.equal(fresh.mode, 'drawLine');
  assert.equal(fresh.pointerEvents, 'auto');
  for (const [x, y] of [[400, 500], [480, 530]]) {
    await dispatch('Input.dispatchMouseEvent', {type:'mousePressed', x, y, button:'left', clickCount:1});
    await dispatch('Input.dispatchMouseEvent', {type:'mouseReleased', x, y, button:'left', clickCount:1});
  }
  const freshLine = await evaluate('({count:state.config.regions.length,mode:state.mode,points:state.config.regions[0]?.points.length})');
  assert.deepEqual(freshLine, {count:1, mode:'selectTool', points:2});
  const staleDraft = await evaluate('(() => { mode("drawLine"); state.draft=[[0,0],[1,1]]; document.getElementById("newGeometry").click(); return {modalOpen:!document.getElementById("geometryModal").hidden,mode:state.mode,draft:state.draft.length}; })()');
  assert.deepEqual(staleDraft, {modalOpen:true, mode:'selectTool', draft:0});
  console.log(JSON.stringify(initial));
  console.log(JSON.stringify({zoneDirection}));
  console.log(JSON.stringify({occupancyControls}));
  console.log(JSON.stringify({zoom}));
  console.log(JSON.stringify({editing, dragged, redrawn}));
  console.log(JSON.stringify({drawStart, drawn}));
  console.log(JSON.stringify(created));
  console.log(JSON.stringify(ruled));
  console.log(JSON.stringify({converted}));
  console.log(JSON.stringify({headingStart,headingTurned,headingSpread,movedAnchor}));
  console.log(JSON.stringify({fresh,freshLine,staleDraft}));
  socket.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
