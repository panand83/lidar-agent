const $ = id => document.getElementById(id);
const canvas = $('scene'), ctx = canvas.getContext('2d');
const state = {lidars: [], id: null, snapshot: null, config: null, tab: 'scene', mode: 'pan', selectedRegion: null, selectedRule: null, draft: [], pendingMapPoint: null, bounds: [-20, -20, 150, 40], dirty: false};
function message(text) {$('message').textContent=text; setTimeout(()=>{if($('message').textContent===text)$('message').textContent=''},5000)}
async function api(path, method='GET', body) {const response=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.error||response.statusText);return data}
function path(){return '/api/lidars/'+encodeURIComponent(state.id)}
function uid(prefix){return prefix+'-'+crypto.randomUUID()}
function dirty(){state.dirty=true;$('save').textContent='Save *';renderCanvas()}
function clean(){state.dirty=false;$('save').textContent='Save'}
async function loadList(){state.lidars=await api('/api/lidars');$('lidars').replaceChildren(...state.lidars.map(item=>{const b=document.createElement('button');b.className='agent'+(item.id===state.id?' active':'');b.innerHTML='<strong></strong><small></small>';b.querySelector('strong').textContent=item.name;b.querySelector('small').textContent=(item.enabled?'Enabled':'Disabled')+' · '+item.status.tracks+' tracks';b.onclick=()=>select(item.id);return b}))}
async function select(id){state.id=id;state.selectedRegion=null;state.selectedRule=null;state.draft=[];await refresh();await loadList();setTab(state.tab)}
async function refresh(){if(!state.id)return;const snap=await api(path());state.snapshot=snap;if(!state.dirty)state.config=structuredClone(snap.config);$('empty').hidden=true;renderFields();renderCanvas();renderStatus()}
function setTab(tab){state.tab=tab;document.querySelectorAll('nav [data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));for(const name of ['lidar','mqtt','map','calibration','geometry','rules','events','scene'])$(name+'Panel').hidden=name!==tab;renderFields();renderCanvas()}
document.querySelectorAll('nav [data-tab]').forEach(button => {
  button.addEventListener('click', () => {
    if (state.config) setTab(button.dataset.tab);
  });
});
function val(id){return $(id).value}function num(id){return Number(val(id))}function csv(id){return val(id).split(',').map(x=>x.trim()).filter(Boolean)}
function renderFields(){const c=state.config;if(!c)return;$('lidarName').value=c.name;$('lidarId').value=c.id;$('sensorId').value=c.sensor_id||'';$('enabled').checked=c.enabled!==false;$('maxGap').value=c.max_gap_sec;$('maxJump').value=c.max_jump_m;for(const [id,key] of [['mqttHost','host'],['mqttPort','port'],['mqttTopic','topic'],['mqttUser','username'],['mqttPassword','password'],['mqttEventTopic','event_topic'],['mqttQos','qos']])$(id).value=c.mqtt[key]??'';renderGeometryList();renderRuleList();renderControls();renderAuto();renderEvents();$('sceneSummary').textContent=`${c.regions.length} geometries · ${c.rules.length} rules · ${state.snapshot?.status.tracks||0} active tracks`}
function bind(id,action){$(id).addEventListener('change',()=>{if(!state.config)return;action();dirty();renderFields()})}
bind('lidarName',()=>state.config.name=val('lidarName'));bind('sensorId',()=>state.config.sensor_id=val('sensorId'));bind('enabled',()=>state.config.enabled=$('enabled').checked);bind('maxGap',()=>state.config.max_gap_sec=num('maxGap'));bind('maxJump',()=>state.config.max_jump_m);
for(const [id,key] of [['mqttHost','host'],['mqttPort','port'],['mqttTopic','topic'],['mqttUser','username'],['mqttPassword','password'],['mqttEventTopic','event_topic'],['mqttQos','qos']])bind(id,()=>state.config.mqtt[key]=['port','qos'].includes(key)?num(id):val(id));
function selectedRegion(){return state.config?.regions.find(r=>r.id===state.selectedRegion)}
function selectedRule(){return state.config?.rules.find(r=>r.id===state.selectedRule)}
function renderGeometryList(){const c=state.config;if(!c)return;$('geometryList').replaceChildren(...c.regions.map(r=>{const b=document.createElement('button');b.className='listItem'+(r.id===state.selectedRegion?' active':'');b.textContent=`${r.type==='line'?'Line':'Polygon'} · ${r.name}`;b.onclick=()=>{state.selectedRegion=r.id;renderFields()};return b}));const r=selectedRegion();$('geometryEdit').hidden=!r;if(!r)return;$('geometryName').value=r.name;$('lineDirection').value=r.line_direction||'forward';$('sensitivity').value=r.crossing_sensitivity_m??0.35;$('padding').value=r.endpoint_padding_m??0;for(const id of ['directionLabel','sensitivityLabel','paddingLabel','reverseArrow'])$(id).hidden=r.type!=='line'}
bind('geometryName',()=>selectedRegion().name=val('geometryName'));bind('lineDirection',()=>selectedRegion().line_direction=val('lineDirection'));bind('sensitivity',()=>selectedRegion().crossing_sensitivity_m=num('sensitivity'));bind('padding',()=>selectedRegion().endpoint_padding_m=num('padding'));
$('reverseArrow').onclick=()=>{const r=selectedRegion();if(!r)return;const a=r.points[0],b=r.points[1],h=r.forward_hint||[0,0];const dx=b[0]-a[0],dy=b[1]-a[1],mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2;const den=dx*dx+dy*dy;const t=den?((h[0]-a[0])*dx+(h[1]-a[1])*dy)/den:0;const foot=[a[0]+t*dx,a[1]+t*dy];r.forward_hint=[2*foot[0]-h[0],2*foot[1]-h[1]];dirty()};
$('deleteGeometry').onclick=()=>{const r=selectedRegion();if(!r)return;state.config.regions=state.config.regions.filter(x=>x.id!==r.id);state.config.rules=state.config.rules.filter(x=>x.region_id!==r.id&&!x.line_region_ids?.includes(r.id));state.selectedRegion=null;dirty();renderFields()};
function renderRuleList(){const c=state.config;if(!c)return;$('ruleList').replaceChildren(...c.rules.map(r=>{const b=document.createElement('button');b.className='listItem'+(r.id===state.selectedRule?' active':'');b.textContent=`${r.enabled?'●':'○'} ${r.name} · ${r.type}`;b.onclick=()=>{state.selectedRule=r.id;renderFields()};return b}));const r=selectedRule();$('ruleEdit').hidden=!r;if(!r)return;$('ruleName').value=r.name;$('ruleType').value=r.type;$('ruleRegion').replaceChildren(...c.regions.filter(g=>r.type==='line_crossing'?g.type==='line':g.type==='polygon').map(g=>{const o=document.createElement('option');o.value=g.id;o.textContent=g.name;return o}));$('ruleRegion').value=r.region_id||r.line_region_ids?.[0]||'';$('sequenceFields').hidden=r.type!=='line_crossing';$('triggerMode').value=r.line_trigger_mode||'any';$('lineIds').value=(r.line_region_ids||[]).join(', ');$('ruleDirection').value=r.direction_mode||'any';$('ruleClasses').value=(r.class_filter||[]).join(', ');$('minSpeed').value=r.min_speed_mps||0;$('minAge').value=r.min_track_age_ms||0;$('debounce').value=r.debounce_ms||0;$('occupancyInterval').value=r.publish_interval_ms||500;$('ruleEnabled').checked=r.enabled!==false}
$('addRule').onclick=()=>{if(!state.config)return;const region=state.config.regions[0];if(!region){message('Draw geometry first');return}const type=region.type==='line'?'line_crossing':'zone_transition';const r={id:uid('rule'),name:'New rule',type,enabled:true,region_id:region.id,line_region_ids:type==='line_crossing'?[region.id]:[],line_trigger_mode:'any',direction_mode:'any',class_filter:[],min_speed_mps:0,min_track_age_ms:0,debounce_ms:1500,publish_interval_ms:500};state.config.rules.push(r);state.selectedRule=r.id;dirty();renderFields()};
for(const [id,key,convert] of [['ruleName','name',val],['ruleType','type',val],['ruleRegion','region_id',val],['triggerMode','line_trigger_mode',val],['lineIds','line_region_ids',csv],['ruleDirection','direction_mode',val],['ruleClasses','class_filter',csv],['minSpeed','min_speed_mps',num],['minAge','min_track_age_ms',num],['debounce','debounce_ms',num],['occupancyInterval','publish_interval_ms',num]])bind(id,()=>{const r=selectedRule();r[key]=convert(id);if(id==='ruleType'){const region=state.config.regions.find(g=>g.type===(r.type==='line_crossing'?'line':'polygon'));r.region_id=region?.id||'';r.line_region_ids=r.type==='line_crossing'&&region?[region.id]:[]}if(id==='ruleRegion'&&r.type==='line_crossing')r.line_region_ids=[r.region_id]});
bind('ruleEnabled',()=>selectedRule().enabled=$('ruleEnabled').checked);$('deleteRule').onclick=()=>{state.config.rules=state.config.rules.filter(r=>r.id!==state.selectedRule);state.selectedRule=null;dirty();renderFields()};
function renderControls(){const points=state.config?.map_alignment?.control_points||[];$('controlList').replaceChildren(...points.map((p,i)=>{const row=document.createElement('div');row.className='controlRow';for(const [key,title] of [['x','X (m)'],['y','Y (m)'],['lat','Latitude'],['lon','Longitude']]){const label=document.createElement('label');label.textContent=title;const input=document.createElement('input');input.type='number';input.step='any';input.value=p[key]??'';input.onchange=()=>{p[key]=Number(input.value);dirty()};label.append(input);row.append(label)}const del=document.createElement('button');del.textContent='Remove';del.onclick=()=>{points.splice(i,1);dirty();renderControls()};row.append(del);return row}))}
$('addControlRow').onclick=()=>{const p=state.pendingMapPoint||{x:0,y:0};state.config.map_alignment.control_points.push({x:p.x,y:p.y,lat:0,lon:0});state.pendingMapPoint=null;dirty();renderControls()};
$('applyMap').onclick=()=>{const pts=state.config.map_alignment.control_points;if(pts.length<2){message('Add at least two control points');return}let ax=0,ay=0,bx=0,by=0,n=pts.length;for(const p of pts){ax+=p.x;ay+=p.y;bx+=p.lon;by+=p.lat}ax/=n;ay/=n;bx/=n;by/=n;let c=0,s=0,den=0;for(const p of pts){const x=p.x-ax,y=p.y-ay,lon=p.lon-bx,lat=p.lat-by;c+=x*lon+y*lat;s+=x*lat-y*lon;den+=x*x+y*y}if(den<1e-9){message('Control points need distinct XY positions');return}const a=c/den,b=s/den;state.config.map_alignment.transform={a,b,lon0:bx-a*ax+b*ay,lat0:by-b*ax-a*ay};$('mapResult').textContent='Aligned with '+n+' points';dirty()};
$('startAuto').onclick=async()=>{try{await api(path()+'/auto-start','POST',{target_tracks:num('targetTracks'),target_points:num('targetPoints'),min_track_points:num('minTrackPoints'),min_displacement_m:num('minDisplacement'),class_filter:csv('autoClasses')});await refresh()}catch(e){message(e.message)}};
$('resetAuto').onclick=async()=>{try{await api(path()+'/auto-reset','POST',{});await refresh()}catch(e){message(e.message)}};
$('applyAuto').onclick=async()=>{try{await api(path()+'/auto-apply','POST',{});clean();await refresh()}catch(e){message(e.message)}};
function renderAuto(){const a=state.snapshot?.auto;$('autoStatus').textContent=a?.running?`Collecting: ${a.track_count} tracks, ${a.point_count} points`:a?.suggestion?`Suggestion: ${a.suggestion.track_count} tracks, confidence ${a.suggestion.confidence}`:'Idle';$('applyAuto').hidden=!a?.suggestion}
function renderEvents(){const events=state.snapshot?.events||[];$('eventsList').replaceChildren(...events.slice(0,50).map(e=>{const div=document.createElement('div');div.className='event';const strong=document.createElement('strong');strong.textContent=e.rule_name||e.event_type;div.append(strong,document.createTextNode(`${e.event_type} · ${e.direction||e.count+' objects'} · ${new Date(e.timestamp*1000).toLocaleTimeString()}`));return div}))}
$('resetEvents').onclick = async () => {
  if (!state.id || !confirm('Clear recent events for this LiDAR?')) return;
  try {
    await api(path() + '/events-reset', 'POST', {});
    if (state.snapshot) state.snapshot.events = [];
    renderEvents();
    renderCanvas();
    message('Recent events cleared');
  } catch (error) { message(error.message); }
};
function renderStatus(){const s=state.snapshot?.status;if(!s)return;$('status').textContent=`MQTT ${s.mqtt_status||'unknown'} · ${s.messages} messages · latest objects ${s.raw_in_last_message??0}/${s.valid_in_last_message??0} valid · ${s.tracks} tracks · ${s.last_received?'Last received '+new Date(s.last_received*1000).toLocaleTimeString():'Waiting for data'}${s.error?' · '+s.error:''}`}
async function save(){if(!state.config)return;try{await api(path(),'POST',state.config);clean();await refresh();await loadList();message('Saved')}catch(e){message(e.message)}}$('save').onclick=save;
$('addLidar').onclick=async()=>{const name=prompt('LiDAR name');if(!name)return;const id=(name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'lidar')+'-'+Math.floor(Math.random()*10000);try{await api('/api/lidars','POST',{id,name});await select(id);setTab('lidar')}catch(e){message(e.message)}};
$('deleteLidar').onclick=async()=>{if(!state.id||!confirm('Delete this LiDAR agent and its saved configuration?'))return;try{await api(path(),'DELETE');state.id=null;state.config=null;state.snapshot=null;await loadList();$('empty').hidden=false;for(const name of ['lidar','mqtt','map','calibration','geometry','rules','events','scene'])$(name+'Panel').hidden=true;renderCanvas()}catch(e){message(e.message)}};
function fit(){const points=[...(state.snapshot?.tracks||[]).flatMap(t=>t.points),...(state.config?.regions||[]).flatMap(r=>r.points),...(state.config?.roi||[])];if(!points.length){state.bounds=[-20,-20,150,40];renderCanvas();return}let xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);let minx=Math.min(...xs),maxx=Math.max(...xs),miny=Math.min(...ys),maxy=Math.max(...ys);let pad=Math.max(5,(maxx-minx+maxy-miny)*.08);state.bounds=[minx-pad,miny-pad,maxx+pad,maxy+pad];renderCanvas()}$('fit').onclick=fit;
function resize(){const rect=canvas.getBoundingClientRect(),scale=devicePixelRatio||1;canvas.width=Math.max(1,Math.round(rect.width*scale));canvas.height=Math.max(1,Math.round(rect.height*scale));renderCanvas()}new ResizeObserver(resize).observe(canvas);
function screen(p){const [x0,y0,x1,y1]=state.bounds;const scale=Math.min(canvas.width/(x1-x0),canvas.height/(y1-y0))*.9;return [canvas.width/2+(p[0]-(x0+x1)/2)*scale,canvas.height/2-(p[1]-(y0+y1)/2)*scale]}
function world(p){const [x0,y0,x1,y1]=state.bounds;const scale=Math.min(canvas.width/(x1-x0),canvas.height/(y1-y0))*.9;return [(p[0]-canvas.width/2)/scale+(x0+x1)/2,(canvas.height/2-p[1])/scale+(y0+y1)/2]}
function line(points,color,width=2,dash=[]){if(points.length<2)return;ctx.beginPath();points.forEach((p,i)=>{const q=screen(p);i?ctx.lineTo(...q):ctx.moveTo(...q)});ctx.strokeStyle=color;ctx.lineWidth=width*(devicePixelRatio||1);ctx.setLineDash(dash.map(x=>x*(devicePixelRatio||1)));ctx.stroke();ctx.setLineDash([])}
function alternating(points,accent){line(points,'#fff',4,[18,18]);ctx.lineDashOffset=18*(devicePixelRatio||1);line(points,accent,4,[18,18]);ctx.lineDashOffset=0}
function renderCanvas(){ctx.fillStyle='#050b1a';ctx.fillRect(0,0,canvas.width,canvas.height);if(!state.config)return;const [x0,y0,x1,y1]=state.bounds;ctx.strokeStyle='#1c2e4d';ctx.lineWidth=1;for(let x=Math.ceil(x0/10)*10;x<=x1;x+=10){const a=screen([x,y0]),b=screen([x,y1]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke()}for(let y=Math.ceil(y0/10)*10;y<=y1;y+=10){const a=screen([x0,y]),b=screen([x1,y]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke()}const activeIds=new Set((state.snapshot?.events||[]).filter(e=>Date.now()/1000-e.timestamp<2).flatMap(e=>[e.line_region_id,e.region_id]));const assigned=new Set(state.config.rules.filter(r=>r.enabled).flatMap(r=>r.line_region_ids?.length?r.line_region_ids:[r.region_id]));if(state.config.roi?.length){line([...state.config.roi,state.config.roi[0]],'#e879f9',2)}for(const r of state.config.regions){const active=activeIds.has(r.id),accent=active?'#ffdc00':r.type==='line'?(assigned.has(r.id)?'#2878ff':'#9b9b9b'):'#00dcff';const pts=r.type==='polygon'?[...r.points,r.points[0]]:r.points;alternating(pts,accent);if(r.type==='polygon'){ctx.fillStyle=active?'#ffd90038':'#28cdee24';ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(...screen(p)):ctx.moveTo(...screen(p)));ctx.fill()}if(r.type==='line'&&r.forward_hint){const mid=screen(r.points[Math.floor((r.points.length-1)/2)]),tip=screen(r.forward_hint);const a=Math.atan2(tip[1]-mid[1],tip[0]-mid[0]);ctx.fillStyle=accent;ctx.beginPath();ctx.moveTo(mid[0]+14*Math.cos(a),mid[1]+14*Math.sin(a));ctx.lineTo(mid[0]+8*Math.cos(a+2.5),mid[1]+8*Math.sin(a+2.5));ctx.lineTo(mid[0]+8*Math.cos(a-2.5),mid[1]+8*Math.sin(a-2.5));ctx.fill()}if(r.id===state.selectedRegion){for(const p of r.points){const q=screen(p);ctx.fillStyle='#fff';ctx.fillRect(q[0]-4,q[1]-4,8,8)}}}for(const track of state.snapshot?.tracks||[]){line(track.points,'#ffd54f',2);const p=screen([track.x,track.y]);ctx.fillStyle=track.class==='car'?'#32d296':track.class==='person'?'#f472b6':'#ef6b77';ctx.beginPath();ctx.arc(p[0],p[1],5*(devicePixelRatio||1),0,Math.PI*2);ctx.fill()}if(state.draft.length)line(state.draft,'#ffd54f',2,[5,5])}
function mode(name){state.mode=name;document.querySelectorAll('.canvasTools button').forEach(b=>b.classList.toggle('active',b.id===name));state.draft=[];renderCanvas()}
for(const id of ['pan','drawLine','drawPolygon','drawRoi','addControl'])$(id).onclick=()=>mode(id);
function pointer(e){const r=canvas.getBoundingClientRect(),scale=devicePixelRatio||1;return [(e.clientX-r.left)*scale,(e.clientY-r.top)*scale]}
canvas.addEventListener('click',e=>{if(!state.config)return;const point=world(pointer(e));if(state.mode==='addControl'){state.pendingMapPoint={x:+point[0].toFixed(3),y:+point[1].toFixed(3)};$('addControlRow').click();setTab('map');return}if(state.mode==='drawLine'||state.mode==='drawPolygon'||state.mode==='drawRoi'){state.draft.push(point);renderCanvas();return}let nearest=null,best=14*(devicePixelRatio||1);for(const r of state.config.regions){for(const p of r.points){const q=screen(p),d=Math.hypot(q[0]-pointer(e)[0],q[1]-pointer(e)[1]);if(d<best){best=d;nearest=r}}}if(nearest){state.selectedRegion=nearest.id;setTab('geometry')}});
canvas.addEventListener('dblclick',e=>{e.preventDefault();finishDraft()});canvas.addEventListener('contextmenu',e=>{e.preventDefault();finishDraft()});
function finishDraft(){if(!state.config)return;const m=state.mode,d=state.draft;if(m==='drawLine'&&d.length>=2){const a=d[0],b=d[d.length-1],dx=b[0]-a[0],dy=b[1]-a[1];const region={id:uid('line'),name:'New line',type:'line',points:d.map(p=>p.map(v=>+v.toFixed(3))),forward_hint:[(a[0]+b[0])/2-dy*.25,(a[1]+b[1])/2+dx*.25],line_direction:'forward',endpoint_padding_m:0,crossing_sensitivity_m:0.35};state.config.regions.push(region);state.selectedRegion=region.id;dirty();setTab('geometry')}else if(m==='drawPolygon'&&d.length>=3){const region={id:uid('polygon'),name:'New zone',type:'polygon',points:d.map(p=>p.map(v=>+v.toFixed(3)))};state.config.regions.push(region);state.selectedRegion=region.id;dirty();setTab('geometry')}else if(m==='drawRoi'&&d.length>=3){state.config.roi=d.map(p=>p.map(v=>+v.toFixed(3)));dirty()}state.draft=[];mode('pan');renderFields()}
window.addEventListener('keydown',e=>{if(e.key==='Escape'){state.draft=[];mode('pan')}});
async function poll(){if(state.id){try{state.snapshot=await api(path());renderCanvas();renderStatus();renderAuto();renderEvents();$('sceneSummary').textContent=`${state.config?.regions.length||0} geometries · ${state.config?.rules.length||0} rules · ${state.snapshot.status.tracks} active tracks`}catch(e){message(e.message)}}await loadList().catch(()=>{});setTimeout(poll,1500)}
loadList().then(()=>{if(state.lidars[0])select(state.lidars[0].id);poll()}).catch(e=>message(e.message));

let draggingNode = null;
function segmentDistance(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = dx * dx + dy * dy ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}
canvas.addEventListener('pointerdown', e => {
  if (state.mode !== 'selectTool' || !state.config) return;
  const pointerPosition = pointer(e);
  let best = 11 * (devicePixelRatio || 1);
  draggingNode = null;
  const ordered = [...state.config.regions].sort((a, b) => (a.id === state.selectedRegion ? -1 : b.id === state.selectedRegion ? 1 : 0));
  for (const region of ordered) {
    region.points.forEach((point, index) => {
      const position = screen(point);
      const distance = Math.hypot(position[0] - pointerPosition[0], position[1] - pointerPosition[1]);
      if (distance < best) {
        best = distance;
        draggingNode = {region, index, start: [...point], hint: region.forward_hint && [...region.forward_hint], moved: false};
      }
    });
  }
  if (!draggingNode) {
    const candidate = ordered.find(region => {
      const points = region.points.map(screen);
      const count = region.type === 'polygon' ? points.length : points.length - 1;
      for (let index = 0; index < count; index++) {
        if (segmentDistance(pointerPosition, points[index], points[(index + 1) % points.length]) < 12 * (devicePixelRatio || 1)) return true;
      }
      return region.type === 'polygon' && insideMapPolygon(world(pointerPosition), region.points);
    });
    if (candidate) {
      state.selectedRegion = candidate.id;
      draggingNode = {region: candidate, start: world(pointerPosition), points: candidate.points.map(point => [...point]),
        hint: candidate.forward_hint && [...candidate.forward_hint], moved: false};
    }
  }
  if (draggingNode) canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (!draggingNode) return;
  const point = world(pointer(e));
  if (Math.hypot(...point.map((value, index) => value - draggingNode.start[index])) < 0.01 && !draggingNode.moved) return;
  draggingNode.moved = true;
  if (draggingNode.points) {
    draggingNode.region.points = draggingNode.points.map(original => original.map((value, index) => +(value + point[index] - draggingNode.start[index]).toFixed(3)));
  } else {
    draggingNode.region.points[draggingNode.index] = point.map(value => +value.toFixed(3));
  }
  if (draggingNode.points && draggingNode.hint) {
    draggingNode.region.forward_hint = [draggingNode.hint[0] + point[0] - draggingNode.start[0], draggingNode.hint[1] + point[1] - draggingNode.start[1]];
  } else if (draggingNode.region.type === 'line') {
    updateLineHint(draggingNode.region);
  }
  renderCanvas();
});
canvas.addEventListener('pointerup', () => {
  if (draggingNode?.moved) {
    state.suppressGeometryClick = true;
    setTimeout(() => { state.suppressGeometryClick = false; }, 0);
    dirty();
  }
  draggingNode = null;
});
canvas.addEventListener('pointercancel', () => { draggingNode = null; });
