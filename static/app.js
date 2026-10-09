const $ = id => document.getElementById(id);
const canvas = $('scene'), ctx = canvas.getContext('2d');
const state = {lidars: [], id: null, snapshot: null, live: null, liveEvents: [], eventCursor: null, config: null, tab: 'rules', mode: 'pan', selectedRegion: null, selectedRule: null, draft: [], bounds: [-20, -20, 150, 40], dirty: false, alertSeen: null, ruleAlertUntil: new Map(), geometryAlertUntil: new Map()};
const markerSvgs = {
  car: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 100 160" fill="none">
  <rect x="12" y="31" width="9" height="20" rx="4" fill="#253854"/>
  <rect x="79" y="31" width="9" height="20" rx="4" fill="#253854"/>
  <rect x="12" y="111" width="9" height="22" rx="4" fill="#253854"/>
  <rect x="79" y="111" width="9" height="22" rx="4" fill="#253854"/>
  <path d="M50 3C30 3 20 11 18 27L16 57 10 61 10 72 17 70 17 128C17 148 29 157 50 157S83 148 83 128V70L90 72V61L84 57 82 27C80 11 70 3 50 3Z" fill="#1677FF" stroke="#0758D4" stroke-width="2"/>
  <path d="M50 9C34 9 26 15 24 29L23 57Q50 43 77 57L76 29C74 15 66 9 50 9Z" fill="#55A5FF"/>
  <path d="M27 49Q50 41 73 49L69 67Q50 71 31 67Z" fill="#DBEAFE" stroke="#0758D4" stroke-width="2"/>
  <path d="M31 72Q50 76 69 72L72 117Q50 127 28 117Z" fill="#2786FA"/>
  <path d="M31 119Q50 126 69 119L72 137Q50 149 28 137Z" fill="#DBEAFE" stroke="#0758D4" stroke-width="2"/>
  <path d="M22 16Q26 10 34 10L29 26 21 30Z M78 16Q74 10 66 10L71 26 79 30Z" fill="#F8FBFF"/>
  <path d="M23 143Q30 153 37 153L30 144 23 138Z M77 143Q70 153 63 153L70 144 77 138Z" fill="#003F9E"/>
  <path d="M28 75Q23 89 27 107M72 75Q77 89 73 107" stroke="#0758D4" stroke-width="3"/>
</svg>`,
  human: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 100 140">
<title>Red walking person top view</title>
<!-- rear foot -->
<path d="M54 76 Q64 73 66 84 L66 103 Q65 113 58 113 Q51 112 51 102 L50 84Z" fill="#d71920" stroke="#9b1015" stroke-width="2"/>
<path d="M55 96 L63 96 M55 100 L63 100" stroke="white" stroke-width="2.3" stroke-linecap="round"/>
<!-- legs -->
<path d="M35 64 Q28 78 35 98 L40 116 Q44 123 52 118 L54 111 L50 88 L57 78 L64 88 L70 84 L68 69Z" fill="#a30e16" stroke="#790a12" stroke-width="2"/>
<path d="M36 81 Q36 95 45 108 L49 109 L44 85Z" fill="#c91a22"/>
<!-- forward foot -->
<path d="M39 112 Q36 119 37 128 Q38 136 47 137 Q57 136 57 127 L54 113Z" fill="#f32831" stroke="#a80913" stroke-width="2"/>
<path d="M40 128 Q47 135 54 127 M42 119 L51 119 M42 123 L51 123" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
<!-- arms and hands -->
<path d="M26 38 Q13 41 12 59 Q12 70 19 72 Q27 73 30 64 L36 49Z" fill="#ef232c" stroke="#a90915" stroke-width="2"/>
<path d="M14 67 Q9 71 12 78 Q17 85 24 79 Q28 74 24 68Z" fill="#ffb276" stroke="#f47742" stroke-width="2"/>
<path d="M74 36 Q85 40 88 58 L89 80 Q89 88 81 89 Q73 88 73 80 L70 51Z" fill="#f32930" stroke="#a90915" stroke-width="2"/>
<path d="M77 84 Q74 92 81 98 Q90 102 94 93 Q96 87 89 82Z" fill="#ffb276" stroke="#f47742" stroke-width="2"/>
<!-- torso -->
<path d="M28 36 Q36 28 49 30 Q65 27 74 37 L76 56 Q73 74 59 79 Q39 82 27 65 Q24 53 28 36Z" fill="#f4232d" stroke="#ad0913" stroke-width="2.5"/>
<path d="M29 41 Q31 55 45 59 Q63 65 73 47 Q68 70 56 72 Q37 73 29 59Z" fill="#d90f19"/>
<path d="M32 38 Q39 31 48 34 Q41 39 37 47Z M63 35 Q71 37 73 46 L67 51Z" fill="#ff5156"/>
<!-- neck and ears -->
<ellipse cx="31" cy="32" rx="6" ry="9" fill="#ffb978" stroke="#ee783f" stroke-width="1.5"/>
<ellipse cx="69" cy="32" rx="6" ry="9" fill="#ffb978" stroke="#ee783f" stroke-width="1.5"/>
<path d="M38 43 Q50 56 62 43 L61 34 L39 34Z" fill="#ffc18a"/>
<!-- hair top -->
<path d="M50 3 Q68 2 71 21 Q74 40 62 47 Q51 55 38 47 Q27 39 28 23 Q28 7 50 3Z" fill="#341b16" stroke="#210e0d" stroke-width="2.5"/>
<path d="M35 25 Q36 9 54 9 Q63 10 66 20 Q54 12 43 22 Q37 30 38 38 Q31 35 35 25Z" fill="#63372c"/>
<path d="M42 17 Q52 7 64 17 Q52 13 45 25Z" fill="#845041"/>
</svg>`,
};
const markerImages = Object.fromEntries(Object.entries(markerSvgs).map(([name, svg]) => {
  const image = new Image();
  image.addEventListener('load', () => renderCanvas());
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return [name, image];
}));
const markerDirections = new Map();
function drawTrackMarker(track, point) {
  const kind = String(track.class || '').toLowerCase();
  const image = kind === 'car' ? markerImages.car : ['person', 'human'].includes(kind) ? markerImages.human : null;
  const ratio = devicePixelRatio || 1;
  if (image?.complete && image.naturalWidth) {
    ctx.save();
    ctx.translate(point[0], point[1]);
    if (kind === 'car' || kind === 'person' || kind === 'human') {
      const key = JSON.stringify([state.id, track.frame, track.sensor, track.id]);
      const points = track.points || [];
      if (points.length < 2) markerDirections.delete(key);
      else {
        const first = points[Math.max(0, points.length - 6)];
        const last = points[points.length - 1];
        const dx = last[0] - first[0], dy = last[1] - first[1];
        const scale = Number(state.config?.map_alignment?.geo?.scale) || 1;
        if (Math.hypot(dx, dy) >= 0.25 * scale) markerDirections.set(key, {dx, dy, at: Date.now()});
      }
      const motion = markerDirections.get(key);
      if (motion) {
        const ahead = screen([track.x + motion.dx, track.y + motion.dy]);
        ctx.rotate(Math.atan2(ahead[1] - point[1], ahead[0] - point[0]) + Math.PI / 2);
      }
      if (markerDirections.size > 500) {
        const expired = Date.now() - 10000;
        for (const [id, value] of markerDirections) if (value.at < expired) markerDirections.delete(id);
      }
    }
    const size = 20 * ratio;
    ctx.drawImage(image, -size / 2, -size / 2, size, size);
    ctx.restore();
    return;
  }
  ctx.fillStyle = kind === 'car' ? '#1677FF' : ['person', 'human'].includes(kind) ? '#EF4444' : '#4b5563';
  ctx.beginPath();
  ctx.arc(point[0], point[1], 5 * ratio, 0, Math.PI * 2);
  ctx.fill();
}
function message(text) {$('message').textContent=text; setTimeout(()=>{if($('message').textContent===text)$('message').textContent=''},5000)}
async function api(path, method='GET', body) {const response=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.error||response.statusText);return data}
function path(){return '/api/lidars/'+encodeURIComponent(state.id)}
function switchControl(checked, label, onChange){
  const control=document.createElement('label');
  control.className='toggleControl';
  control.title=label;
  const input=document.createElement('input');
  input.type='checkbox';
  input.checked=checked;
  input.setAttribute('aria-label',label);
  input.onchange=()=>onChange(input.checked,input);
  const track=document.createElement('span');
  track.className='toggleTrack';
  track.setAttribute('aria-hidden','true');
  const text=document.createElement('span');
  text.className='toggleText';
  text.textContent=checked?'Enabled':'Disabled';
  control.append(input,track,text);
  return control;
}
async function setAgentEnabled(id,enabled,input){
  input.disabled=true;
  let saved=false;
  try{
    await api('/api/lidars/'+encodeURIComponent(id)+'/enabled','POST',{enabled});
    saved=true;
    input.closest('.toggleControl').querySelector('.toggleText').textContent=enabled?'Enabled':'Disabled';
    if(state.id===id&&state.config){
      state.config.enabled=enabled;
      if(state.snapshot?.config)state.snapshot.config.enabled=enabled;
      $('enabled').checked=enabled;
      $('enabled').closest('.toggleControl').querySelector('.toggleText').textContent=enabled?'Enabled':'Disabled';
      state.live=null;
      state.snapshot=await api(path());
      renderStatus();
      renderCanvas();
    }
    await loadList();
    message(`LiDAR ${enabled?'enabled':'disabled'}`);
  }catch(error){
    if(!saved){
      input.checked=!enabled;
      input.closest('.toggleControl').querySelector('.toggleText').textContent=enabled?'Disabled':'Enabled';
    }
    message(error.message);
  }finally{input.disabled=false;}
}
function uid(prefix){
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&0x0f)|0x40;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
  return `${prefix}-${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function dirty(){state.dirty=true;$('save').textContent='Save *';renderCanvas()}
function clean(){state.dirty=false;$('save').textContent='Save'}
async function loadList(){
  state.lidars=await api('/api/lidars');
  const root=$('lidars');
  const existing=new Map([...root.children].map(row=>[row.dataset.lidarId,row]));
  const rows=state.lidars.map(item=>{
    let row=existing.get(item.id);
    if(!row){
      row=document.createElement('div');
      row.dataset.lidarId=item.id;
      const button=document.createElement('button');
      button.className='agentSelect';
      button.innerHTML='<strong></strong><small></small>';
      button.onclick=()=>select(item.id);
      const toggle=switchControl(item.enabled,`Toggle ${item.name}`,(enabled,input)=>setAgentEnabled(item.id,enabled,input));
      row.append(button,toggle);
    }
    row.className='agentRow'+(item.id===state.id?' active':'');
    row.querySelector('strong').textContent=item.name;
    const lastReceived=item.status.last_received;
    const stale=item.enabled&&(!lastReceived||Date.now()/1000-lastReceived>10);
    row.querySelector('small').textContent=item.enabled?(stale?'No recent matching frames':item.status.tracks+' tracks'):'Disabled';
    const input=row.querySelector('input');
    if(!input.disabled){
      input.checked=item.enabled;
      input.setAttribute('aria-label',`${item.enabled?'Disable':'Enable'} ${item.name}`);
      row.querySelector('.toggleText').textContent=item.enabled?'Enabled':'Disabled';
    }
    return row;
  });
  if(rows.length!==root.children.length||rows.some((row,index)=>root.children[index]!==row))root.replaceChildren(...rows);
}
async function select(id, discardConfirmed=false){if(state.id!==id&&state.dirty&&!discardConfirmed&&!confirm('Discard unsaved changes to this LiDAR?'))return false;state.id=id;state.snapshot=null;state.live=null;state.liveEvents=[];state.eventCursor=null;state.alertSeen=null;state.ruleAlertUntil=new Map();state.geometryAlertUntil=new Map();clean();state.selectedRegion=null;state.selectedRule=null;state.draft=[];await refresh();mode('pan');await loadList();setTab(state.tab);return true}
function eventGeometryIds(event){
  const explicit=[...(event.line_region_ids||[]),event.line_region_id,event.region_id].filter(Boolean);
  if(explicit.length)return [...new Set(explicit)];
  const rule=state.config?.rules.find(item=>item.id===event.rule_id);
  return [...(rule?.line_region_ids||[]),rule?.region_id].filter(Boolean);
}
function updateRuleAlerts(){
  const events=state.snapshot?.events||[];
  if(state.alertSeen===null){state.alertSeen=new Set(events.map(event=>event.event_id).filter(Boolean));}
  else{
    const now=Date.now();
    for(const event of events){
      if(!event.event_id||state.alertSeen.has(event.event_id))continue;
      state.alertSeen.add(event.event_id);
      state.ruleAlertUntil.set(event.rule_id,now+3000);
      for(const id of eventGeometryIds(event))state.geometryAlertUntil.set(id,now+3000);
    }
    if(state.alertSeen.size>500)state.alertSeen=new Set(events.map(event=>event.event_id).filter(Boolean));
  }
  for(const row of document.querySelectorAll('.ruleRow[data-rule-id]')){
    const active=(state.ruleAlertUntil?.get(row.dataset.ruleId)||0)>Date.now();
    row.classList.toggle('eventFlash',active);
  }
}
function trackIdentity(track){return JSON.stringify([track.frame,track.sensor,track.id])}
function mergeLiveEvents(snap){
  const seen=new Set();
  snap.events=[...state.liveEvents,...snap.events].filter(event=>{
    if(seen.has(event.event_id))return false;
    seen.add(event.event_id);
    return true;
  }).sort((a,b)=>b.timestamp-a.timestamp).slice(0,200);
}
function applyLiveSnapshot(live){
  state.live=live;
  if(live.events?.length){
    const seen=new Set();
    state.liveEvents=[...live.events,...state.liveEvents].filter(event=>{
      if(seen.has(event.event_id))return false;
      seen.add(event.event_id);
      return true;
    }).slice(0,200);
    state.eventCursor=live.events[0].event_id;
  }
  const snap=state.snapshot;
  if(snap&&live.events?.length)mergeLiveEvents(snap);
  if(!snap||!live||!live.status.last_received||live.status.last_received<(snap.status.last_received||0))return;
  const previous=new Map(snap.tracks.map(track=>[trackIdentity(track),track]));
  snap.tracks=live.tracks.map(head=>{
    const old=previous.get(trackIdentity(head));
    if(!old||head.time<old.time)return {...head,points:[[head.x,head.y]]};
    if(head.time===old.time)return old;
    const points=[...old.points,[head.x,head.y]];
    if(points.length>2000)points.shift();
    return {...head,points};
  });
  Object.assign(snap.status,live.status);
}
function applyFullSnapshot(snap){
  state.snapshot=snap;
  if(!state.eventCursor&&snap.events.length)state.eventCursor=snap.events[0].event_id;
  mergeLiveEvents(snap);
  if(state.live)applyLiveSnapshot(state.live);
}
async function refresh(){if(!state.id)return;const id=state.id,snap=await api(path());if(state.id!==id)return;applyFullSnapshot(snap);if(!state.dirty)state.config=structuredClone(snap.config);$('empty').hidden=true;renderFields();updateRuleAlerts();renderCanvas();renderStatus()}
function setTab(tab){state.tab=tab;document.querySelectorAll('nav [data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));for(const name of ['lidar','mqtt','map','calibration','geometry','rules','integrations','events','scene'])$(name+'Panel').hidden=name!==tab;renderFields();renderCanvas()}
document.querySelectorAll('nav [data-tab]').forEach(button => {
  button.addEventListener('click', () => {
    if (state.config) setTab(button.dataset.tab);
  });
});
function val(id){return $(id).value}function num(id){return Number(val(id))}function csv(id){return val(id).split(',').map(x=>x.trim()).filter(Boolean)}
function renderFields(){const c=state.config;if(!c)return;$('lidarName').value=c.name;$('lidarId').value=c.id;$('trackingSource').value=c.source||'Flasheye';$('sensorId').value=c.sensor_id||'';$('enabled').checked=c.enabled!==false;$('enabled').closest('.toggleControl').querySelector('.toggleText').textContent=c.enabled!==false?'Enabled':'Disabled';$('maxGap').value=c.max_gap_sec;$('maxJump').value=c.max_jump_m;for(const [id,key] of [['mqttHost','host'],['mqttPort','port'],['mqttTopic','topic'],['mqttUser','username'],['mqttPassword','password'],['mqttEventTopic','event_topic'],['mqttQos','qos']])$(id).value=c.mqtt[key]??'';renderGeometryList();renderRuleList();renderControls();renderEvents();$('sceneSummary').textContent=`${c.regions.length} geometries · ${c.rules.length} rules · ${state.snapshot?.status.tracks||0} active tracks`}
function bind(id,action){$(id).addEventListener('change',()=>{if(!state.config)return;action();dirty();renderFields()})}
bind('lidarName',()=>state.config.name=val('lidarName'));bind('trackingSource',()=>state.config.source=val('trackingSource'));bind('sensorId',()=>state.config.sensor_id=val('sensorId'));$('enabled').onchange=event=>{if(state.id)setAgentEnabled(state.id,event.target.checked,event.target)};bind('maxGap',()=>state.config.max_gap_sec=num('maxGap'));bind('maxJump',()=>state.config.max_jump_m);
for(const [id,key] of [['mqttHost','host'],['mqttPort','port'],['mqttTopic','topic'],['mqttUser','username'],['mqttPassword','password'],['mqttEventTopic','event_topic'],['mqttQos','qos']])bind(id,()=>state.config.mqtt[key]=['port','qos'].includes(key)?num(id):val(id));
function selectedRegion(){return state.config?.regions.find(r=>r.id===state.selectedRegion)}
function selectedRule(){return state.config?.rules.find(r=>r.id===state.selectedRule)}
function visibleTracks(){return (state.snapshot?.tracks||[]).filter(track=>{
  const name=String(track.class||'').toLowerCase();
  const group=['car','truck','bus','motorcycle','bicycle'].includes(name)?'showVehicles':
    ['person','human'].includes(name)?'showHumans':'showOther';
  return $(group).checked;
})}
for(const id of ['showVehicles','showHumans','showOther'])$(id).onchange=()=>renderCanvas();
function renderGeometryList(){const c=state.config;if(!c)return;$('geometryList').replaceChildren(...c.regions.map(r=>{const b=document.createElement('button');b.className='listItem'+(r.id===state.selectedRegion?' active':'');b.textContent=`${r.type==='line'?'Line':'Polygon'} · ${r.name}`;b.onclick=()=>{state.selectedRegion=r.id;renderFields()};return b}));const r=selectedRegion();$('geometryEdit').hidden=!r;if(!r)return;$('geometryName').value=r.name;$('lineDirection').value=r.line_direction||'forward';$('sensitivity').value=r.crossing_sensitivity_m??0.35;$('padding').value=r.endpoint_padding_m??0;for(const id of ['directionLabel','sensitivityLabel','paddingLabel','reverseArrow'])$(id).hidden=r.type!=='line'}
bind('geometryName',()=>selectedRegion().name=val('geometryName'));bind('lineDirection',()=>selectedRegion().line_direction=val('lineDirection'));bind('sensitivity',()=>selectedRegion().crossing_sensitivity_m=num('sensitivity'));bind('padding',()=>selectedRegion().endpoint_padding_m=num('padding'));
$('reverseArrow').onclick=()=>{const r=selectedRegion();if(!r)return;const a=r.points[0],b=r.points[1],h=r.forward_hint||[0,0];const dx=b[0]-a[0],dy=b[1]-a[1],mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2;const den=dx*dx+dy*dy;const t=den?((h[0]-a[0])*dx+(h[1]-a[1])*dy)/den:0;const foot=[a[0]+t*dx,a[1]+t*dy];r.forward_hint=[2*foot[0]-h[0],2*foot[1]-h[1]];dirty()};
$('deleteGeometry').onclick=()=>{const r=selectedRegion();if(!r)return;state.config.regions=state.config.regions.filter(x=>x.id!==r.id);state.config.rules=state.config.rules.filter(x=>x.region_id!==r.id&&!x.line_region_ids?.includes(r.id));state.selectedRegion=null;dirty();renderFields()};
function renderRuleList(){const c=state.config;if(!c)return;$('ruleList').replaceChildren(...c.rules.map(r=>{const b=document.createElement('button');b.className='listItem'+(r.id===state.selectedRule?' active':'');b.textContent=`${r.enabled?'●':'○'} ${r.name} · ${r.type}`;b.onclick=()=>{state.selectedRule=r.id;renderFields()};return b}));const r=selectedRule();$('ruleEdit').hidden=!r;if(!r)return;$('ruleName').value=r.name;$('ruleType').value=r.type;$('ruleRegion').replaceChildren(...c.regions.filter(g=>r.type==='line_crossing'?g.type==='line':g.type==='polygon').map(g=>{const o=document.createElement('option');o.value=g.id;o.textContent=g.name;return o}));$('ruleRegion').value=r.region_id||r.line_region_ids?.[0]||'';$('sequenceFields').hidden=r.type!=='line_crossing';$('triggerMode').value=r.line_trigger_mode||'any';$('lineIds').value=(r.line_region_ids||[]).join(', ');$('ruleDirection').value=r.direction_mode||'any';$('ruleClasses').value=(r.class_filter||[]).join(', ');$('minSpeed').value=r.min_speed_mps||0;$('minAge').value=r.min_track_age_ms||0;$('debounce').value=r.debounce_ms||0;$('occupancyInterval').value=r.publish_interval_ms||500;$('ruleEnabled').checked=r.enabled!==false}
$('addRule').onclick=()=>{if(!state.config)return;const region=state.config.regions[0];if(!region){message('Draw geometry first');return}const type=region.type==='line'?'line_crossing':'zone_transition';const r={id:uid('rule'),name:'New rule',type,enabled:true,region_id:region.id,line_region_ids:type==='line_crossing'?[region.id]:[],line_trigger_mode:'any',direction_mode:'any',class_filter:[],min_speed_mps:0,min_track_age_ms:0,debounce_ms:1500,publish_interval_ms:500};state.config.rules.push(r);state.selectedRule=r.id;dirty();renderFields()};
for(const [id,key,convert] of [['ruleName','name',val],['ruleType','type',val],['ruleRegion','region_id',val],['triggerMode','line_trigger_mode',val],['lineIds','line_region_ids',csv],['ruleDirection','direction_mode',val],['ruleClasses','class_filter',csv],['minSpeed','min_speed_mps',num],['minAge','min_track_age_ms',num],['debounce','debounce_ms',num],['occupancyInterval','publish_interval_ms',num]])bind(id,()=>{const r=selectedRule();r[key]=convert(id);if(id==='ruleType'){const region=state.config.regions.find(g=>g.type===(r.type==='line_crossing'?'line':'polygon'));r.region_id=region?.id||'';r.line_region_ids=r.type==='line_crossing'&&region?[region.id]:[]}if(id==='ruleRegion'&&r.type==='line_crossing')r.line_region_ids=[r.region_id]});
bind('ruleEnabled',()=>selectedRule().enabled=$('ruleEnabled').checked);$('deleteRule').onclick=()=>{state.config.rules=state.config.rules.filter(r=>r.id!==state.selectedRule);state.selectedRule=null;dirty();renderFields()};
function renderControls(){const points=state.config?.map_alignment?.control_points||[];$('controlList').replaceChildren(...points.map((p,i)=>{const row=document.createElement('div');row.className='controlRow';for(const [key,title] of [['x','X (m)'],['y','Y (m)'],['lat','Latitude'],['lon','Longitude']]){const label=document.createElement('label');label.textContent=title;const input=document.createElement('input');input.type='number';input.step='any';input.value=p[key]??'';input.onchange=()=>{p[key]=input.value===''?null:Number(input.value);dirty()};label.append(input);row.append(label)}const del=document.createElement('button');del.textContent='Remove';del.onclick=()=>{points.splice(i,1);dirty();renderControls()};row.append(del);return row}))}
$('addControlRow').onclick=()=>{state.config.map_alignment.control_points.push({x:null,y:null,lat:null,lon:null});dirty();renderControls()};
function renderEvents(){const events=state.snapshot?.events||[];$('eventsList').replaceChildren(...events.slice(0,50).map(e=>{const div=document.createElement('div');div.className='event';const strong=document.createElement('strong');strong.textContent=e.rule_name||e.event_type;div.append(strong,document.createTextNode(`${e.event_type} · ${e.direction||e.count+' objects'} · ${new Date(e.timestamp*1000).toLocaleTimeString()}`));return div}))}
$('resetEvents').onclick = async () => {
  if (!state.id || !confirm('Clear recent events for this LiDAR?')) return;
  try {
    await api(path() + '/events-reset', 'POST', {});
    state.live=null;
    state.liveEvents=[];
    if (state.snapshot) state.snapshot.events = [];
    renderEvents();
    renderCanvas();
    message('Recent events cleared');
  } catch (error) { message(error.message); }
};
$('resetObjects').onclick = async () => {
  if (!state.id || !confirm('Clear tracked objects and paths for this LiDAR?')) return;
  try {
    const lidarId = state.id;
    await api(path() + '/tracks-reset', 'POST', {});
    if (state.id !== lidarId) return;
    state.live = null;
    state.snapshot = await api(path());
    renderCanvas();
    renderStatus();
    message('Tracked objects cleared');
  } catch (error) { message(error.message); }
};
function renderStatus(){
  const s=state.snapshot?.status;
  if(!s)return;
  const enabled=state.config?.enabled!==false;
  const stale=enabled&&s.mqtt_status==='subscribed'&&(!s.last_received||Date.now()/1000-s.last_received>10);
  const sensor=state.config?.sensor_id;
  const warning=!enabled?'LiDAR disabled':stale?`No recent matching frames${sensor?' for '+sensor:''}`:'';
  const p=s.processing;
  const processing=p?` · queue ${p.queue_depth}/${p.queue_limit} · wait ${p.last_queue_wait_ms} ms · process ${p.last_processing_ms} ms · event ${p.last_event_latency_ms??'-'} ms · dropped ${p.dropped_frames}${p.resync_pending?' · resyncing':''}`:'';
  const status=$('status');
  status.classList.toggle('warning',Boolean(warning));
  status.textContent=`${warning?warning+' · ':''}MQTT ${s.mqtt_status||'unknown'} · ${s.messages} messages · latest objects ${s.raw_in_last_message??0}/${s.valid_in_last_message??0} valid · ${s.tracks} tracks${processing} · ${s.last_received?'Last received '+new Date(s.last_received*1000).toLocaleTimeString():'Waiting for data'}${s.error?' · '+s.error:''}`;
}
async function save(){if(!state.config)return false;try{await api(path(),'POST',state.config);clean();await refresh();await loadList();message('Saved');return true}catch(e){message(e.message);return false}}$('save').onclick=save;
const lidarSetupModal=document.createElement('div');
lidarSetupModal.id='lidarSetupModal';
lidarSetupModal.className='modalBackdrop';
lidarSetupModal.hidden=true;
lidarSetupModal.innerHTML=`<div class="modalBox lidarSetupBox" role="dialog" aria-modal="true" aria-labelledby="lidarSetupTitle">
  <h2 id="lidarSetupTitle">Add LiDAR</h2>
  <div class="lidarSetupModes" role="group" aria-label="Add LiDAR method">
    <button id="lidarManualMode" type="button" class="active">Manual</button>
    <button id="lidarRestoreMode" type="button">Restore backup</button>
  </div>
  <form id="lidarSetupForm">
    <div id="lidarManualFields"><label>Name<input id="newLidarName" autocomplete="off" required></label>
      <label>LiDAR ID<input id="newLidarId" autocomplete="off" placeholder="Generated from name if blank"></label></div>
    <div id="lidarRestoreFields" hidden><label>Backup JSON<input id="lidarBackupFile" type="file" accept=".json,application/json"></label>
      <div id="lidarBackupDetails" class="lidarBackupDetails" role="status"></div>
      <label>Name<input id="restoreLidarName" autocomplete="off"></label>
      <label>LiDAR ID<input id="restoreLidarId" autocomplete="off"></label>
      <label>Restore action<select id="restoreLidarAction"><option value="create">Create new agent</option><option value="replace">Replace existing agent</option></select></label></div>
    <div id="lidarSetupError" class="lidarSetupError" role="alert"></div>
    <div class="lidarSetupActions"><button id="cancelLidarSetup" type="button">Cancel</button>
      <button id="submitLidarSetup" type="submit" class="primary">Add LiDAR</button></div>
  </form></div>`;
document.body.append(lidarSetupModal);
let lidarSetupMode='manual';
let selectedBackup=null;
function closeLidarSetup(){lidarSetupModal.hidden=true;$('addLidar').focus()}
function setLidarSetupMode(next){
  lidarSetupMode=next;
  $('lidarManualFields').hidden=next!=='manual';
  $('lidarRestoreFields').hidden=next!=='restore';
  $('newLidarName').required=next==='manual';
  $('lidarBackupFile').required=next==='restore';
  $('restoreLidarName').required=next==='restore';
  $('restoreLidarId').required=next==='restore';
  $('lidarSetupError').textContent='';
  $('lidarManualMode').classList.toggle('active',next==='manual');
  $('lidarRestoreMode').classList.toggle('active',next==='restore');
  $('submitLidarSetup').textContent=next==='manual'?'Add LiDAR':'Restore LiDAR';
  $(next==='manual'?'newLidarName':'lidarBackupFile').focus();
}
$('lidarManualMode').onclick=()=>setLidarSetupMode('manual');
$('lidarRestoreMode').onclick=()=>setLidarSetupMode('restore');
$('cancelLidarSetup').onclick=closeLidarSetup;
lidarSetupModal.onclick=event=>{if(event.target===lidarSetupModal)closeLidarSetup()};
lidarSetupModal.addEventListener('keydown',event=>{if(event.key==='Escape')closeLidarSetup()});
$('addLidar').onclick=()=>{
  if(state.dirty&&!confirm('Discard unsaved changes to this LiDAR?'))return;
  $('lidarSetupForm').reset();
  $('lidarBackupDetails').textContent='';
  $('lidarSetupError').textContent='';
  selectedBackup=null;
  lidarSetupModal.hidden=false;
  setLidarSetupMode('manual');
};
$('lidarBackupFile').onchange=async()=>{
  selectedBackup=null;
  const file=$('lidarBackupFile').files?.[0];
  if(!file){$('lidarBackupDetails').textContent='';return}
  try{
    if(file.size>5_000_000)throw Error('Backup file is too large');
    const config=JSON.parse(await file.text());
    if(!config||Array.isArray(config)||typeof config!=='object'||!config.id)throw Error('Choose a single LiDAR configuration JSON file');
    selectedBackup=config;
    $('restoreLidarName').value=String(config.name||config.id);
    $('restoreLidarId').value=String(config.id);
    $('lidarBackupDetails').textContent=`${file.name} · ${config.name||config.id}`;
  }catch(error){$('lidarBackupDetails').textContent=error.message}
};
$('lidarSetupForm').onsubmit=async event=>{
  event.preventDefault();
  const submit=$('submitLidarSetup');
  submit.disabled=true;
  try{
    let id;
    if(lidarSetupMode==='manual'){
      const name=$('newLidarName').value.trim();
      if(!name)throw Error('LiDAR name is required');
      id=$('newLidarId').value.trim()||((name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48)||'lidar')+'-'+Math.floor(Math.random()*10000));
      await api('/api/lidars','POST',{id,name});
    }else{
      if(!selectedBackup)throw Error('Choose a valid LiDAR backup JSON file');
      id=$('restoreLidarId').value.trim();
      if(!id)throw Error('LiDAR ID is required');
      const name=$('restoreLidarName').value.trim();
      if(!name)throw Error('LiDAR name is required');
      const replace=$('restoreLidarAction').value==='replace';
      if(replace&&!confirm(`Replace all saved settings for LiDAR ${id}? Its live tracks will reset.`))return;
      await api('/api/lidars/restore','POST',{config:{...selectedBackup,id,name},replace});
    }
    closeLidarSetup();
    await select(id,true);
    setTab('lidar');
    message(lidarSetupMode==='manual'?'LiDAR added':'LiDAR configuration restored');
  }catch(error){$('lidarSetupError').textContent=error.message}
  finally{submit.disabled=false}
};
const lidarPanelActions=document.createElement('div');
lidarPanelActions.className='lidarPanelActions';
const downloadLidarConfig=document.createElement('button');
downloadLidarConfig.id='downloadLidarConfig';
downloadLidarConfig.textContent='Download Configuration';
const deleteLidarButton=$('deleteLidar');
deleteLidarButton.before(lidarPanelActions);
lidarPanelActions.append(downloadLidarConfig,deleteLidarButton);
downloadLidarConfig.onclick=async()=>{
  if(!state.id)return;
  const note=state.dirty?'Unsaved changes will not be included. ':'';
  if(!confirm(`${note}Download the saved configuration for ${state.id}? This file may include MQTT credentials.`))return;
  try{
    const response=await fetch(path()+'/backup',{cache:'no-store'});
    if(!response.ok){const error=await response.json();throw Error(error.error||'Download failed')}
    const url=URL.createObjectURL(await response.blob());
    const link=document.createElement('a');
    link.href=url;
    link.download=`${state.id}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){message(error.message)}
};
$('deleteLidar').onclick=async()=>{if(!state.id||!confirm('Delete this LiDAR agent and its saved configuration?'))return;try{await api(path(),'DELETE');state.id=null;state.config=null;state.snapshot=null;state.live=null;state.liveEvents=[];state.eventCursor=null;state.ruleAlertUntil=new Map();state.geometryAlertUntil=new Map();clean();mode('pan');await loadList();$('empty').hidden=false;for(const name of ['lidar','mqtt','map','calibration','geometry','rules','integrations','events','scene'])$(name+'Panel').hidden=true;renderCanvas()}catch(e){message(e.message)}};
function fit(){const points=[...visibleTracks().flatMap(t=>t.points),...(state.config?.regions||[]).flatMap(r=>r.points)];if(!points.length){state.bounds=[-20,-20,150,40];renderCanvas();return}let xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);let minx=Math.min(...xs),maxx=Math.max(...xs),miny=Math.min(...ys),maxy=Math.max(...ys);let pad=Math.max(5,(maxx-minx+maxy-miny)*.08);state.bounds=[minx-pad,miny-pad,maxx+pad,maxy+pad];renderCanvas()}$('fit').onclick=fit;
function resize(){const rect=canvas.getBoundingClientRect(),scale=devicePixelRatio||1;canvas.width=Math.max(1,Math.round(rect.width*scale));canvas.height=Math.max(1,Math.round(rect.height*scale));renderCanvas()}new ResizeObserver(resize).observe(canvas);
function screen(p){const [x0,y0,x1,y1]=state.bounds;const scale=Math.min(canvas.width/(x1-x0),canvas.height/(y1-y0))*.9;return [canvas.width/2+(p[0]-(x0+x1)/2)*scale,canvas.height/2-(p[1]-(y0+y1)/2)*scale]}
function world(p){const [x0,y0,x1,y1]=state.bounds;const scale=Math.min(canvas.width/(x1-x0),canvas.height/(y1-y0))*.9;return [(p[0]-canvas.width/2)/scale+(x0+x1)/2,(canvas.height/2-p[1])/scale+(y0+y1)/2]}
function line(points,color,width=2,dash=[]){if(points.length<2)return;ctx.beginPath();points.forEach((p,i)=>{const q=screen(p);i?ctx.lineTo(...q):ctx.moveTo(...q)});ctx.strokeStyle=color;ctx.lineWidth=width*(devicePixelRatio||1);ctx.setLineDash(dash.map(x=>x*(devicePixelRatio||1)));ctx.stroke();ctx.setLineDash([])}
function alternating(points,accent){line(points,'#fff',4,[18,18]);ctx.lineDashOffset=18*(devicePixelRatio||1);line(points,accent,4,[18,18]);ctx.lineDashOffset=0}
function renderCanvas(){ctx.fillStyle='#050b1a';ctx.fillRect(0,0,canvas.width,canvas.height);if(!state.config)return;const [x0,y0,x1,y1]=state.bounds;ctx.strokeStyle='#1c2e4d';ctx.lineWidth=1;for(let x=Math.ceil(x0/10)*10;x<=x1;x+=10){const a=screen([x,y0]),b=screen([x,y1]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke()}for(let y=Math.ceil(y0/10)*10;y<=y1;y+=10){const a=screen([x0,y]),b=screen([x1,y]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke()}const activeIds=state.geometryAlertUntil;const assigned=new Set(state.config.rules.filter(r=>r.enabled).flatMap(r=>r.line_region_ids?.length?r.line_region_ids:[r.region_id]));for(const r of state.config.regions){const active=(activeIds.get(r.id)||0)>Date.now(),accent=active?'#ffdc00':r.type==='line'?(assigned.has(r.id)?'#2878ff':'#9b9b9b'):'#00dcff';const pts=r.type==='polygon'?[...r.points,r.points[0]]:r.points;alternating(pts,accent);if(r.type==='polygon'){ctx.fillStyle=active?'#ffd90038':'#28cdee24';ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(...screen(p)):ctx.moveTo(...screen(p)));ctx.fill()}if(r.type==='line'&&r.forward_hint){const mid=screen(r.points[Math.floor((r.points.length-1)/2)]),tip=screen(r.forward_hint);const a=Math.atan2(tip[1]-mid[1],tip[0]-mid[0]);ctx.fillStyle=accent;ctx.beginPath();ctx.moveTo(mid[0]+14*Math.cos(a),mid[1]+14*Math.sin(a));ctx.lineTo(mid[0]+8*Math.cos(a+2.5),mid[1]+8*Math.sin(a+2.5));ctx.lineTo(mid[0]+8*Math.cos(a-2.5),mid[1]+8*Math.sin(a-2.5));ctx.fill()}if(r.id===state.selectedRegion){for(const p of r.points){const q=screen(p);ctx.fillStyle='#fff';ctx.fillRect(q[0]-4,q[1]-4,8,8)}}}for(const track of state.snapshot?.tracks||[]){line(track.points,'#ffd54f',2);const p=screen([track.x,track.y]);drawTrackMarker(track,p)}if(state.draft.length)line(state.draft,'#ffd54f',2,[5,5])}
function mode(name){state.mode=name;document.querySelectorAll('.canvasTools button').forEach(b=>b.classList.toggle('active',b.id===name));state.draft=[];renderCanvas()}
for(const id of ['pan','drawLine','drawPolygon'])$(id).onclick=()=>mode(id);
function pointer(e){const r=canvas.getBoundingClientRect(),scale=devicePixelRatio||1;return [(e.clientX-r.left)*scale,(e.clientY-r.top)*scale]}
canvas.addEventListener('click',e=>{if(!state.config)return;const point=world(pointer(e));if(state.mode==='drawLine'||state.mode==='drawPolygon'){state.draft.push(point);renderCanvas();return}let nearest=null,best=14*(devicePixelRatio||1);for(const r of state.config.regions){for(const p of r.points){const q=screen(p),d=Math.hypot(q[0]-pointer(e)[0],q[1]-pointer(e)[1]);if(d<best){best=d;nearest=r}}}if(nearest){state.selectedRegion=nearest.id;setTab('geometry')}});
canvas.addEventListener('dblclick',e=>{e.preventDefault();finishDraft()});canvas.addEventListener('contextmenu',e=>{e.preventDefault();finishDraft()});
function finishDraft(){if(!state.config)return;const m=state.mode,d=state.draft;if(m==='drawLine'&&d.length>=2){const a=d[0],b=d[d.length-1],dx=b[0]-a[0],dy=b[1]-a[1];const region={id:uid('line'),name:'New line',type:'line',points:d.map(p=>p.map(v=>+v.toFixed(3))),forward_hint:[(a[0]+b[0])/2-dy*.25,(a[1]+b[1])/2+dx*.25],line_direction:'forward',endpoint_padding_m:0,crossing_sensitivity_m:0.35};state.config.regions.push(region);state.selectedRegion=region.id;dirty();setTab('geometry')}else if(m==='drawPolygon'&&d.length>=3){const region={id:uid('polygon'),name:'New zone',type:'polygon',points:d.map(p=>p.map(v=>+v.toFixed(3)))};state.config.regions.push(region);state.selectedRegion=region.id;dirty();setTab('geometry')}state.draft=[];mode('pan');renderFields()}
window.addEventListener('keydown',e=>{if(e.key==='Escape'){state.draft=[];mode('pan')}});
let nextAgentListPoll=0;
async function poll(){
  if(state.id){try{const id=state.id,snap=await api(path());if(state.id===id){applyFullSnapshot(snap);updateRuleAlerts();renderCanvas();renderStatus();renderEvents();$('sceneSummary').textContent=`${state.config?.regions.length||0} geometries · ${state.config?.rules.length||0} rules · ${state.snapshot.status.tracks} active tracks`}}catch(e){message(e.message)}}
  if(Date.now()>=nextAgentListPoll){nextAgentListPoll=Date.now()+3000;await loadList().catch(()=>{})}
  setTimeout(poll,2000);
}
async function pollLive(){
  let delay=100;
  if(state.id&&state.snapshot){
    const id=state.id;
    try{const live=await api('/api/lidars/'+encodeURIComponent(id)+'/live'+(state.eventCursor?'?after='+encodeURIComponent(state.eventCursor):''));if(state.id===id){applyLiveSnapshot(live);updateRuleAlerts();renderCanvas();renderStatus();if(live.events?.length)renderEvents()}}
    catch(e){message(e.message);delay=1000}
  }
  setTimeout(pollLive,delay);
}
loadList().then(()=>{const initial=state.lidars.find(item=>item.enabled)||state.lidars[0];if(initial)select(initial.id);poll();pollLive()}).catch(e=>message(e.message));

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
  if (draggingNode) {
    state.selectedRegion = draggingNode.region.id;
    canvas.setPointerCapture(e.pointerId);
  }
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
  if (state.mode === 'selectTool') renderFields();
});
canvas.addEventListener('pointercancel', () => { draggingNode = null; });
