/* Kyra geometry and rule workflow adapted to LiDAR XY meters. */
const kyraSetTab = setTab;
const kyraCanvasRender = renderCanvas;
const kyraMode = mode;
state.geometryEditorOpen = false;
state.ruleEditorOpen = false;
const drawActions = document.createElement('div');
drawActions.className = 'drawActions';
drawActions.hidden = true;
const drawStatus = document.createElement('span');
const finishDrawing = document.createElement('button');
finishDrawing.textContent = 'Finish';
finishDrawing.onclick = () => finishDraft();
const cancelDrawing = document.createElement('button');
cancelDrawing.textContent = 'Cancel';
cancelDrawing.onclick = () => { state.draft = []; mode('selectTool'); };
drawActions.append(drawStatus, finishDrawing, cancelDrawing);
$('geometryPanel').insertBefore(drawActions, $('geometryList'));

function renderDrawActions() {
  const drawing = state.mode === 'drawLine' || state.mode === 'drawPolygon';
  drawActions.hidden = !drawing;
  if (!drawing) return;
  const count = state.draft.length;
  const minimum = state.mode === 'drawLine' ? 2 : 3;
  drawStatus.textContent = `${state.redrawingRegion ? 'Redraw' : 'New'} ${state.mode === 'drawLine' ? 'line' : 'zone'}: ${count}/${minimum} points`;
  finishDrawing.disabled = count < minimum;
  finishDrawing.hidden = state.mode === 'drawLine';
}

function editorIcon(name) {
  const paths = {
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4Z"/>',
    delete: '<path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v6m4-6v6"/>',
    on: '<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="16" cy="12" r="3"/>',
    off: '<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="8" cy="12" r="3"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}

function iconButton(icon, title, action, dangerous = false) {
  const button = document.createElement('button');
  button.className = 'iconButton' + (dangerous ? ' danger' : '');
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = editorIcon(icon);
  button.onclick = event => { event.stopPropagation(); action(); };
  return button;
}

function regionAssigned(id) {
  return state.config.rules.some(rule => rule.enabled && (rule.region_id === id || rule.line_region_ids?.includes(id)));
}

renderGeometryList = function () {
  if (!state.config) return;
  const root = $('geometryList');
  root.replaceChildren();
  for (const region of state.config.regions) {
    const row = document.createElement('div');
    row.className = 'kyraRow' + (state.selectedRegion === region.id ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'rowName';
    name.textContent = region.name;
    name.onclick = () => {
      state.selectedRegion = state.selectedRegion === region.id ? null : region.id;
      state.geometryEditorOpen = false;
      if (state.selectedRegion) mode('selectTool');
      renderFields();
    };
    const chip = document.createElement('span');
    chip.className = 'typeChip';
    chip.textContent = region.type;
    row.append(name, chip,
      iconButton('edit', 'Edit geometry', () => {
        state.selectedRegion = region.id;
        state.geometryEditorOpen = true;
        mode('selectTool');
        renderFields();
        $('geometryName').focus();
      }),
      iconButton('delete', 'Delete geometry', () => removeGeometry(region.id), true));
    root.append(row);
  }
  const region = selectedRegion();
  $('geometryEdit').hidden = !region || !state.geometryEditorOpen;
  if (!region) return;
  $('geometryName').value = region.name;
  let redraw = $('redrawGeometry');
  if (!redraw) {
    redraw = document.createElement('button');
    redraw.id = 'redrawGeometry';
    redraw.textContent = 'Redraw';
    $('geometryEdit').insertBefore(redraw, $('reverseArrow'));
  }
  redraw.onclick = () => {
    state.draft = [];
    mode(region.type === 'line' ? 'drawLine' : 'drawPolygon');
    state.redrawingRegion = region.id;
    state.selectedRegion = null;
    state.geometryEditorOpen = false;
    renderFields();
    renderDrawActions();
    message(`Draw the replacement ${region.type === 'line' ? 'line' : 'zone'} on the map`);
  };
  $('geometryType').value = region.type;
  $('lineDirection').value = region.line_direction || 'forward';
  $('sensitivity').value = region.crossing_sensitivity_m ?? .35;
  $('padding').value = region.endpoint_padding_m ?? 0;
  for (const id of ['directionLabel', 'sensitivityLabel', 'paddingLabel', 'reverseArrow']) {
    $(id).hidden = region.type !== 'line';
  }
};

function removeGeometry(id) {
  const region = state.config.regions.find(item => item.id === id);
  if (!region || !confirm(`Delete ${region.name}?`)) return;
  state.config.regions = state.config.regions.filter(item => item.id !== id);
  for (const rule of state.config.rules) {
    if (rule.region_id === id) rule.region_id = '';
    if (rule.line_region_ids) rule.line_region_ids = rule.line_region_ids.filter(item => item !== id);
  }
  if (state.selectedRegion === id) state.selectedRegion = null;
  state.geometryEditorOpen = false;
  dirty();
  renderFields();
}
$('deleteGeometry').onclick = () => selectedRegion() && removeGeometry(state.selectedRegion);
$('lineDirection').addEventListener('change', () => {
  const region = selectedRegion();
  if (!region || region.type !== 'line' || region.points.length < 2) return;
  const first = region.points[0], last = region.points[region.points.length - 1];
  const dx = last[0] - first[0], dy = last[1] - first[1];
  const length = Math.hypot(dx, dy) || 1;
  const sign = region.line_direction === 'backward' ? -1 : 1;
  region.forward_hint = [(first[0] + last[0]) / 2 + sign * dy / length * 4,
    (first[1] + last[1]) / 2 - sign * dx / length * 4];
  dirty();
});

function ruleLineChoices(select, lines, selectedId) {
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'None';
  select.append(none);
  for (const region of lines) {
    const option = document.createElement('option');
    option.value = region.id;
    option.textContent = region.name;
    select.append(option);
  }
  select.value = selectedId || '';
}

function renderDirectionChoices(rule) {
  const select = $('ruleDirection');
  const choices = rule.type === 'zone_transition' ? [['any', 'Any (Enter or Leave)'], ['entering', 'Enter'],
    ['leaving', 'Leave'], ['both', 'Both (Enter then Leave)']] :
    rule.type === 'line_crossing' ? [['any', 'Any'], ['forward', 'Forward'], ['backward', 'Backward']] : [['any', 'Any']];
  select.replaceChildren(...choices.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  const current = rule.direction_mode || 'any';
  if (!choices.some(([value]) => value === current)) {
    const unsupported = document.createElement('option');
    unsupported.value = current;
    unsupported.textContent = `Unsupported: ${current} (choose a direction)`;
    select.append(unsupported);
  }
  select.value = current;
  select.disabled = rule.type === 'occupancy';
  return !choices.some(([value]) => value === current);
}

const kyraClasses = ['person', 'human', 'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'other'];
function renderClassChoices(rule) {
  const root = $('ruleClassChoices');
  root.replaceChildren();
  for (const name of kyraClasses) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = (rule.class_filter || []).includes(name);
    checkbox.onchange = () => {
      const selected = [...root.querySelectorAll('input:checked')].map(input => input.value);
      rule.class_filter = selected;
      $('ruleClasses').value = selected.join(',');
      dirty();
    };
    checkbox.value = name;
    label.append(checkbox, document.createTextNode(name));
    root.append(label);
  }
}

renderRuleList = function () {
  if (!state.config) return;
  const root = $('ruleList');
  root.replaceChildren();
  const recent = new Set((state.snapshot?.events || [])
    .filter(event => Date.now() / 1000 - event.timestamp < 3)
    .map(event => event.rule_id));
  for (const rule of state.config.rules) {
    const row = document.createElement('div');
    row.className = 'kyraRow' + (state.selectedRule === rule.id ? ' active' : '');
    const toggle = iconButton(rule.enabled ? 'on' : 'off', rule.enabled ? 'Disable rule' : 'Enable rule', () => {
      rule.enabled = !rule.enabled;
      dirty();
      renderFields();
    });
    const name = document.createElement('span');
    name.className = 'rowName';
    name.textContent = rule.name;
    name.onclick = () => {
      state.selectedRule = state.selectedRule === rule.id ? null : rule.id;
      state.ruleEditorOpen = false;
      renderFields();
    };
    const chip = document.createElement('span');
    chip.className = 'typeChip';
    chip.textContent = rule.type;
    const alert = iconButton('bell', 'Rule alert state', () => {});
    if (recent.has(rule.id)) alert.classList.add('alertOn');
    row.append(toggle, name, chip,
      iconButton('edit', 'Edit rule', () => {
        state.selectedRule = rule.id;
        state.ruleEditorOpen = true;
        renderFields();
        $('ruleName').focus();
      }),
      iconButton('delete', 'Delete rule', () => removeRule(rule.id), true), alert);
    root.append(row);
  }
  const rule = selectedRule();
  $('ruleEdit').hidden = !rule || !state.ruleEditorOpen;
  if (!rule) return;
  $('ruleName').value = rule.name;
  $('ruleType').value = rule.type;
  $('ruleEnabled').checked = rule.enabled !== false;
  $('ruleClasses').value = (rule.class_filter || []).join(',');
  renderClassChoices(rule);
  $('ruleRegionLabel').hidden = rule.type === 'line_crossing';
  $('sequenceFields').hidden = rule.type !== 'line_crossing';
  $('occupancyLabel').hidden = rule.type !== 'occupancy';
  $('ruleDirection').closest('label').hidden = rule.type === 'occupancy';
  const polygons = state.config.regions.filter(region => region.type === 'polygon');
  ruleLineChoices($('ruleRegion'), polygons, rule.region_id);
  const lines = state.config.regions.filter(region => region.type === 'line');
  const ids = rule.line_region_ids || (rule.region_id ? [rule.region_id] : []);
  ruleLineChoices($('ruleLine1'), lines, ids[0]);
  const first = lines.find(region => region.id === ids[0]);
  const compatible = first ? lines.filter(region => region.line_direction === first.line_direction) : lines;
  ruleLineChoices($('ruleLine2'), compatible, ids[1]);
  ruleLineChoices($('ruleLine3'), compatible, ids[2]);
  $('lineIds').value = ids.join(',');
  $('triggerMode').value = rule.line_trigger_mode || 'any';
  const invalidDirection = renderDirectionChoices(rule);
  $('headingEnabled').checked = !!rule.heading_enabled;
  $('headingCenter').value = rule.heading_center_deg ?? 0;
  $('headingDeviation').value = rule.heading_deviation_deg ?? 45;
  const trackFiltersVisible = rule.type !== 'occupancy';
  for (const id of ['headingEnabled', 'headingCenter', 'headingDeviation', 'minSpeed', 'minAge', 'debounce']) {
    $(id).closest('label').hidden = !trackFiltersVisible;
  }
  $('headingTool').parentElement.hidden = !trackFiltersVisible;
  $('headingTool').disabled = !trackFiltersVisible || !rule.heading_enabled;
  $('headingTool').classList.toggle('active', state.mode === 'heading' && trackFiltersVisible);
  const assigned = rule.type === 'line_crossing' ? ids.length > 0 : !!rule.region_id;
  $('ruleEdit').dataset.warning = invalidDirection ? 'This direction cannot trigger this rule. Choose a supported direction and save.' :
    assigned ? '' : 'Assign geometry before this rule can generate events';
  $('minSpeed').value = rule.min_speed_mps || 0;
  $('minAge').value = rule.min_track_age_ms || 0;
  $('debounce').value = rule.debounce_ms || 0;
  $('occupancyInterval').value = rule.publish_interval_ms || 500;
};

function removeRule(id) {
  const rule = state.config.rules.find(item => item.id === id);
  if (!rule || !confirm(`Delete ${rule.name}?`)) return;
  state.config.rules = state.config.rules.filter(item => item.id !== id);
  if (state.selectedRule === id) state.selectedRule = null;
  state.ruleEditorOpen = false;
  dirty();
  renderFields();
}
$('deleteRule').onclick = () => selectedRule() && removeRule(state.selectedRule);

$('addRule').onclick = () => {
  if (!state.config) return;
  const first = state.config.regions[0];
  const type = first?.type === 'polygon' ? 'zone_transition' : 'line_crossing';
  const rule = {id: uid('rule'), name: type === 'line_crossing' ? 'New Line Rule' : 'New Zone Rule',
    type, enabled: true, region_id: first?.id || '', class_filter: ['car']};
  if (type === 'line_crossing') {
    Object.assign(rule, {line_region_ids: first ? [first.id] : [], line_trigger_mode: 'any'});
  }
  if (type !== 'occupancy') {
    Object.assign(rule, {direction_mode: 'any', heading_enabled: false, heading_center_deg: 0,
      heading_deviation_deg: 45, min_speed_mps: 0,
      min_track_age_ms: type === 'line_crossing' ? 0 : 300,
      debounce_ms: type === 'line_crossing' ? 1500 : 2000});
  } else {
    rule.publish_interval_ms = 500;
  }
  state.config.rules.push(rule);
  state.selectedRule = rule.id;
  state.ruleEditorOpen = true;
  dirty();
  renderFields();
};

function updateLineIds() {
  const rule = selectedRule();
  if (!rule) return;
  const ids = [$('ruleLine1').value, $('ruleLine2').value, $('ruleLine3').value].filter(Boolean);
  if (new Set(ids).size !== ids.length) return message('Choose each line only once');
  rule.line_region_ids = ids;
  rule.region_id = ids[0] || '';
  $('lineIds').value = ids.join(',');
  dirty();
  renderFields();
}
for (const id of ['ruleLine1', 'ruleLine2', 'ruleLine3']) $(id).onchange = updateLineIds;
$('ruleType').addEventListener('change', () => {
  const rule = selectedRule();
  if (!rule) return;
  const lineOnly = ['line_region_ids', 'line_trigger_mode'];
  const trackOnly = ['direction_mode', 'heading_enabled', 'heading_center_deg',
    'heading_deviation_deg', 'heading_anchor', 'min_speed_mps', 'min_track_age_ms', 'debounce_ms'];
  if (rule.type !== 'line_crossing') for (const key of lineOnly) delete rule[key];
  if (rule.type !== 'occupancy') {
    delete rule.publish_interval_ms;
    rule.direction_mode ??= 'any';
    rule.heading_enabled ??= false;
    rule.heading_center_deg ??= 0;
    rule.heading_deviation_deg ??= 45;
    rule.min_speed_mps ??= 0;
    rule.min_track_age_ms ??= rule.type === 'zone_transition' ? 300 : 0;
    rule.debounce_ms ??= rule.type === 'zone_transition' ? 2000 : 1500;
  } else {
    for (const key of trackOnly) delete rule[key];
    rule.publish_interval_ms ??= 500;
  }
  const allowed = rule.type === 'zone_transition' ? ['any', 'entering', 'leaving', 'both'] :
    rule.type === 'line_crossing' ? ['any', 'forward', 'backward'] : ['any'];
  if (rule.type !== 'occupancy' && !allowed.includes(rule.direction_mode)) rule.direction_mode = 'any';
  dirty();
  renderFields();
});
for (const [id, key] of [['headingEnabled', 'heading_enabled'], ['headingCenter', 'heading_center_deg'],
  ['headingDeviation', 'heading_deviation_deg']]) {
  $(id).onchange = () => {
    const rule = selectedRule();
    if (!rule) return;
    rule[key] = id === 'headingEnabled' ? $(id).checked : Number($(id).value);
    dirty();
    renderFields();
  };
}

$('headingTool').textContent = 'Adjust Heading';
$('headingTool').onclick = () => {
  if (!selectedRule()?.heading_enabled || selectedRule()?.type === 'occupancy') return;
  mode(state.mode === 'heading' ? 'selectTool' : 'heading');
  renderFields();
};
function headingAnchor(rule) {
  if (Array.isArray(rule.heading_anchor) && rule.heading_anchor.length === 2 &&
      rule.heading_anchor.every(Number.isFinite)) return rule.heading_anchor;
  const id = rule.type === 'line_crossing' ? rule.line_region_ids?.[0] : rule.region_id;
  const region = state.config?.regions.find(item => item.id === id);
  if (region?.points.length) {
    return [region.points.reduce((sum, point) => sum + point[0], 0) / region.points.length,
      region.points.reduce((sum, point) => sum + point[1], 0) / region.points.length];
  }
  return world([canvas.width / 2, canvas.height / 2]);
}
canvas.addEventListener('click', event => {
  if (state.suppressGeometryClick) {
    state.suppressGeometryClick = false;
    event.stopImmediatePropagation();
    return;
  }
  if (state.mode === 'heading') event.stopImmediatePropagation();
}, true);

let headingDrag = null;
function headingEditorGeometry(rule) {
  const center = screen(headingAnchor(rule));
  const ratio = devicePixelRatio || 1;
  return {center, radius: 108 * ratio, hub: 26 * ratio, ratio,
    visualHeading: ((rule.heading_center_deg ?? 0) + 180) % 360};
}
function headingPointerAngle(point, center) {
  return (Math.atan2(point[0] - center[0], center[1] - point[1]) * 180 / Math.PI + 360) % 360;
}
function editHeadingFromPointer(rule, point) {
  const {center, visualHeading} = headingEditorGeometry(rule);
  if (headingDrag.mode === 'move') {
    const translated = [headingDrag.center[0] + point[0] - headingDrag.start[0],
      headingDrag.center[1] + point[1] - headingDrag.start[1]];
    rule.heading_anchor = world(translated);
  } else {
    const angle = headingPointerAngle(point, center);
    if (headingDrag.mode === 'direction') rule.heading_center_deg = (angle + 180) % 360;
    if (headingDrag.mode === 'spread') {
      const delta = ((angle - visualHeading + 180) % 360) - 180;
      rule.heading_deviation_deg = Math.max(5, Math.min(180, Math.abs(delta)));
    }
  }
  $('headingCenter').value = (rule.heading_center_deg ?? 0).toFixed(1);
  $('headingDeviation').value = (rule.heading_deviation_deg ?? 45).toFixed(1);
  dirty();
}
canvas.addEventListener('pointerdown', event => {
  const rule = selectedRule();
  if (state.mode !== 'heading' || !rule?.heading_enabled) return;
  const point = pointer(event);
  const {center, radius, hub, visualHeading} = headingEditorGeometry(rule);
  const distance = Math.hypot(point[0] - center[0], point[1] - center[1]);
  if (distance > radius) return;
  const angle = headingPointerAngle(point, center);
  const delta = Math.abs(((angle - visualHeading + 180) % 360) - 180);
  const editMode = event.button === 2 ? 'spread' :
    event.button === 0 ? distance <= hub || delta > (rule.heading_deviation_deg ?? 45) ? 'move' : 'direction' : null;
  if (!editMode) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  headingDrag = {mode: editMode, start: point, center};
  canvas.setPointerCapture(event.pointerId);
  if (editMode !== 'move') editHeadingFromPointer(rule, point);
}, true);
canvas.addEventListener('pointermove', event => {
  if (!headingDrag || state.mode !== 'heading') return;
  event.preventDefault();
  editHeadingFromPointer(selectedRule(), pointer(event));
}, true);
canvas.addEventListener('pointerup', event => {
  if (!headingDrag) return;
  event.preventDefault();
  headingDrag = null;
  renderFields();
}, true);
canvas.addEventListener('pointercancel', () => { headingDrag = null; }, true);
canvas.addEventListener('contextmenu', event => {
  if (state.mode !== 'heading') return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
canvas.addEventListener('dblclick', event => {
  if (state.mode !== 'heading') return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
canvas.addEventListener('wheel', event => {
  const rule = selectedRule();
  if (state.mode !== 'heading' || !rule?.heading_enabled) return;
  const {center, radius} = headingEditorGeometry(rule);
  const point = pointer(event);
  if (Math.hypot(point[0] - center[0], point[1] - center[1]) > radius) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  rule.heading_deviation_deg = Math.max(5, Math.min(180,
    (rule.heading_deviation_deg ?? 45) + (event.deltaY < 0 ? 4 : -4)));
  $('headingDeviation').value = rule.heading_deviation_deg.toFixed(1);
  dirty();
}, {capture: true, passive: false});

$('newGeometry').onclick = () => { if (state.config) { state.redrawingRegion = null; $('geometryModal').hidden = false; } };
$('cancelGeometry').onclick = () => $('geometryModal').hidden = true;
for (const [id, tool] of [['chooseLine', 'drawLine'], ['choosePolygon', 'drawPolygon']]) {
  $(id).onclick = () => {
    $('geometryModal').hidden = true;
    mode(tool);
    state.selectedRegion = null;
    state.geometryEditorOpen = false;
    renderFields();
  };
}
canvas.addEventListener('click', () => {
  if (state.mode !== 'drawLine' && state.mode !== 'drawPolygon') return;
  renderDrawActions();
  if (state.mode === 'drawLine' && state.draft.length >= 2) finishDraft();
});

finishDraft = function () {
  if (!state.config) return;
  const points = state.draft.map(point => point.map(value => +value.toFixed(3)));
  let region = null;
  const replacing = state.config.regions.find(item => item.id === state.redrawingRegion);
  const validReplacement = replacing && ((state.mode === 'drawLine' && replacing.type === 'line' && points.length >= 2) ||
    (state.mode === 'drawPolygon' && replacing.type === 'polygon' && points.length >= 3));
  if (validReplacement) {
    replacing.points = points;
    if (replacing.type === 'line') {
      const first = points[0], last = points[points.length - 1];
      const dx = last[0] - first[0], dy = last[1] - first[1];
      const length = Math.hypot(dx, dy) || 1;
      const sign = replacing.line_direction === 'backward' ? -1 : 1;
      replacing.forward_hint = [(first[0] + last[0]) / 2 + sign * dy / length * 4,
        (first[1] + last[1]) / 2 - sign * dx / length * 4];
    }
    region = replacing;
    dirty();
  } else if (replacing) {
    state.draft = [];
    state.redrawingRegion = null;
    mode('selectTool');
    return message('Redraw cancelled; original geometry is unchanged');
  }
  if (!region && state.mode === 'drawLine' && points.length >= 2) {
    const first = points[0], last = points[points.length - 1];
    const dx = last[0] - first[0], dy = last[1] - first[1];
    const length = Math.hypot(dx, dy) || 1;
    region = {id: uid('line'), name: `Line ${state.config.regions.filter(item => item.type === 'line').length + 1}`,
      type: 'line', points,
      forward_hint: [(first[0] + last[0]) / 2 + dy / length * 4,
        (first[1] + last[1]) / 2 - dx / length * 4],
      line_direction: 'forward', endpoint_padding_m: 0, crossing_sensitivity_m: .35};
  } else if (!region && state.mode === 'drawPolygon' && points.length >= 3) {
    region = {id: uid('zone'), name: `Zone ${state.config.regions.filter(item => item.type === 'polygon').length + 1}`,
      type: 'polygon', points};
  } else if (!region && state.mode === 'drawRoi' && points.length >= 3) {
    state.config.roi = points;
    dirty();
  }
  if (region && !validReplacement) {
    state.config.regions.push(region);
    dirty();
  }
  if (region) {
    state.selectedRegion = region.id;
    state.geometryEditorOpen = true;
  }
  state.draft = [];
  state.redrawingRegion = null;
  mode('selectTool');
  if (region) setTab('scene');
  else renderFields();
};

setTab = function (tab) {
  kyraSetTab(tab);
  if (tab === 'scene') {
    $('scenePanel').hidden = true;
    $('geometryPanel').hidden = false;
    if (state.config && state.mode === 'pan') mode('selectTool');
  }
};

mode = function (name) {
  if (name !== 'drawLine' && name !== 'drawPolygon') state.redrawingRegion = null;
  kyraMode(name);
  canvas.style.pointerEvents = currentGeo() && name === 'pan' ? 'none' : 'auto';
  canvas.classList.toggle('editing', name === 'selectTool');
  $('selectTool').classList.toggle('active', name === 'selectTool');
  renderDrawActions();
};
$('selectTool').onclick = () => mode('selectTool');

renderCanvas = function () {
  kyraCanvasRender();
  if (selectedRule()?.heading_enabled && selectedRule()?.type !== 'occupancy' && state.tab === 'rules' && state.mode === 'heading') {
    const rule = selectedRule();
    const {center, radius, hub, ratio, visualHeading} = headingEditorGeometry(rule);
    const angle = visualHeading * Math.PI / 180;
    const deviation = (rule.heading_deviation_deg ?? 45) * Math.PI / 180;
    const dialPoint = (bearing, distance) => [center[0] + Math.sin(bearing) * distance,
      center[1] - Math.cos(bearing) * distance];
    ctx.save();
    ctx.fillStyle = 'rgba(34,38,43,.77)';
    ctx.beginPath(); ctx.arc(...center, radius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(247,171,32,.88)';
    ctx.beginPath();
    ctx.moveTo(...center);
    const steps = Math.max(8, Math.ceil(deviation * 2 * 180 / Math.PI / 6));
    for (let step = 0; step <= steps; step++) {
      ctx.lineTo(...dialPoint(angle - deviation + step / steps * deviation * 2, radius));
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(112,82,12,.98)';
    ctx.lineWidth = 3.6 * ratio;
    ctx.beginPath(); ctx.moveTo(...dialPoint(angle, radius * .74));
    ctx.lineTo(...dialPoint(angle, radius * .48)); ctx.stroke();
    const arrowTip = dialPoint(angle, hub + 8 * ratio);
    const arrowBase = dialPoint(angle, radius * .48);
    const arrowLeft = [arrowBase[0] + Math.sin(angle + 142 * Math.PI / 180) * 12 * ratio,
      arrowBase[1] - Math.cos(angle + 142 * Math.PI / 180) * 12 * ratio];
    const arrowRight = [arrowBase[0] + Math.sin(angle - 142 * Math.PI / 180) * 12 * ratio,
      arrowBase[1] - Math.cos(angle - 142 * Math.PI / 180) * 12 * ratio];
    ctx.beginPath(); ctx.moveTo(...arrowTip); ctx.lineTo(...arrowLeft); ctx.lineTo(...arrowRight); ctx.closePath();
    ctx.fillStyle = 'rgba(205,136,18,.98)'; ctx.fill();
    ctx.lineWidth = 2.2 * ratio; ctx.stroke();
    ctx.strokeStyle = 'rgba(245,245,245,.86)'; ctx.lineWidth = 2 * ratio;
    ctx.beginPath(); ctx.arc(...center, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(250,250,250,.9)'; ctx.strokeStyle = 'rgba(40,48,60,.86)';
    ctx.beginPath(); ctx.arc(...center, hub, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    const labelWidth = 178 * ratio, labelHeight = 26 * ratio;
    ctx.fillStyle = 'rgba(24,29,34,.82)';
    ctx.beginPath(); ctx.roundRect(center[0] - labelWidth / 2, center[1] - radius - 36 * ratio,
      labelWidth, labelHeight, 8 * ratio); ctx.fill();
    ctx.fillStyle = '#eee'; ctx.font = `${12 * ratio}px Segoe UI, Arial, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`Heading ${Math.round(rule.heading_center_deg ?? 0)} deg +/- ${Math.round(rule.heading_deviation_deg ?? 45)}`,
      center[0], center[1] - radius - 23 * ratio);
    ctx.restore();
  }
};

function pointSegmentDistance(point, start, end) {
  const vx = end[0] - start[0], vy = end[1] - start[1];
  const denominator = vx * vx + vy * vy;
  const t = denominator ? Math.max(0, Math.min(1, ((point[0] - start[0]) * vx + (point[1] - start[1]) * vy) / denominator)) : 0;
  return Math.hypot(point[0] - start[0] - t * vx, point[1] - start[1] - t * vy);
}

canvas.addEventListener('click', event => {
  if (state.mode !== 'selectTool' || !state.config) return;
  event.stopImmediatePropagation();
  const location = pointer(event);
  for (const region of [...state.config.regions].reverse()) {
    const points = region.points.map(screen);
    const length = region.type === 'polygon' ? points.length : points.length - 1;
    for (let index = 0; index < length; index++) {
      if (pointSegmentDistance(location, points[index], points[(index + 1) % points.length]) < 12 * (devicePixelRatio || 1)) {
        state.selectedRegion = region.id;
        state.geometryEditorOpen = true;
        const rule = selectedRule();
        if (rule && region.type === 'polygon' && rule.type !== 'line_crossing') {
          rule.region_id = region.id;
          dirty();
        }
        renderFields();
        return;
      }
    }
  }
}, true);

canvas.addEventListener('dblclick', event => {
  if (state.mode !== 'selectTool' || !selectedRegion()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const region = selectedRegion();
  const position = pointer(event);
  const points = region.points.map(screen);
  const length = region.type === 'polygon' ? points.length : points.length - 1;
  for (let index = 0; index < length; index++) {
    if (pointSegmentDistance(position, points[index], points[(index + 1) % points.length]) < 14 * (devicePixelRatio || 1)) {
      region.points.splice(index + 1, 0, world(position).map(value => +value.toFixed(3)));
      dirty();
      renderFields();
      break;
    }
  }
}, true);

canvas.addEventListener('contextmenu', event => {
  if (state.mode !== 'selectTool' || !selectedRegion()) return;
  const region = selectedRegion();
  const position = pointer(event);
  const index = region.points.findIndex(point => {
    const pixel = screen(point);
    return Math.hypot(pixel[0] - position[0], pixel[1] - position[1]) < 12 * (devicePixelRatio || 1);
  });
  if (index < 0 || region.points.length <= (region.type === 'line' ? 2 : 3)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  region.points.splice(index, 1);
  if (region.type === 'line') updateLineHint(region);
  dirty();
  renderFields();
}, true);

function updateLineHint(region) {
  const first = region.points[0], last = region.points[region.points.length - 1];
  const dx = last[0] - first[0], dy = last[1] - first[1];
  const length = Math.hypot(dx, dy) || 1;
  const sign = region.line_direction === 'backward' ? -1 : 1;
  region.forward_hint = [(first[0] + last[0]) / 2 + sign * dy / length * 4,
    (first[1] + last[1]) / 2 - sign * dx / length * 4];
}

if (state.config) setTab(state.tab);
