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
    edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    delete: '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    on: '<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="16" cy="12" r="3"/>',
    off: '<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="8" cy="12" r="3"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    zone: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
    layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>'
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

const editorModalFocus = {};
function createEditorModal(kind, title, contentId) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modalBackdrop';
  backdrop.hidden = true;
  const box = document.createElement('div');
  box.className = 'modalBox editorModalBox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const heading = document.createElement('h2');
  heading.id = `${kind}EditorTitle`;
  heading.textContent = title;
  box.setAttribute('aria-labelledby', heading.id);
  heading.title = 'Drag to move';
  let drag = null;
  function positionBox(x, y) {
    const maxX = Math.max(0, (window.innerWidth - box.offsetWidth) / 2 - 12);
    const maxY = Math.max(0, (window.innerHeight - box.offsetHeight) / 2 - 12);
    box.dataset.dragX = Math.max(-maxX, Math.min(maxX, x));
    box.dataset.dragY = Math.max(-maxY, Math.min(maxY, y));
    box.style.transform = `translate(${box.dataset.dragX}px, ${box.dataset.dragY}px)`;
  }
  heading.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = {x: event.clientX, y: event.clientY,
      offsetX: Number(box.dataset.dragX || 0), offsetY: Number(box.dataset.dragY || 0)};
    heading.setPointerCapture(event.pointerId);
  });
  heading.addEventListener('pointermove', event => {
    if (!drag) return;
    positionBox(drag.offsetX + event.clientX - drag.x, drag.offsetY + event.clientY - drag.y);
  });
  heading.addEventListener('pointerup', () => { drag = null; });
  heading.addEventListener('pointercancel', () => { drag = null; });
  window.addEventListener('resize', () => positionBox(Number(box.dataset.dragX || 0), Number(box.dataset.dragY || 0)));
  const actions = document.createElement('div');
  actions.className = 'editorModalActions';
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.onclick = () => closeEditorModal(kind);
  const saveButton = document.createElement('button');
  saveButton.className = 'primary';
  saveButton.textContent = 'Save';
  saveButton.onclick = async () => {
    saveButton.disabled = true;
    try { if (await save()) closeEditorModal(kind); }
    finally { saveButton.disabled = false; }
  };
  actions.append(close, saveButton);
  box.append(heading, $(contentId), actions);
  backdrop.append(box);
  backdrop.onclick = event => { if (event.target === backdrop) closeEditorModal(kind); };
  backdrop.onkeydown = event => {
    if (event.key !== 'Tab') return;
    const focusable = [...box.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])')]
      .filter(element => !element.hidden && element.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  document.body.append(backdrop);
  backdrop.positionBox = positionBox;
  return backdrop;
}
const geometryEditModal = createEditorModal('geometry', 'Edit Geometry', 'geometryEdit');
const ruleEditModal = createEditorModal('rule', 'Edit Rule', 'ruleEdit');
ruleEditModal.querySelector('.editorModalBox').classList.add('ruleEditorModalBox');
$('ruleEdit').classList.add('ruleFormGrid');
$('ruleClassChoices').closest('label').classList.add('ruleFullWidth');
const toleranceLabel = document.createElement('label');
toleranceLabel.id = 'toleranceLabel';
toleranceLabel.textContent = 'Zone boundary tolerance (m)';
const toleranceInput = document.createElement('input');
toleranceInput.id = 'zoneTolerance';
toleranceInput.type = 'number';
toleranceInput.min = '0';
toleranceInput.step = '0.05';
toleranceInput.value = '0';
toleranceInput.onchange = () => {
  const region = selectedRegion();
  if (!region || region.type !== 'polygon') return;
  region.boundary_tolerance_m = Number(toleranceInput.value);
  dirty();
};
toleranceLabel.append(toleranceInput);
$('geometryEdit').insertBefore(toleranceLabel, $('reverseArrow'));

const editorTooltips = {
  geometryName: 'Name shown in the geometry list and rule selectors.',
  geometryType: 'Line or polygon, chosen when this geometry was drawn.',
  lineDirection: 'Sets which side is forward for a crossing line. Reverse the arrow to change it.',
  padding: 'Extends each end of the crossing line by this distance when testing crossings.',
  sensitivity: 'A track must move this far beyond the line to register a crossing.',
  zoneTolerance: 'Ignore position changes close to the zone edge until the object moves this far past it. Zero disables tolerance.',
  ruleType: 'Choose line crossing, zone transition, or occupancy.',
  ruleName: 'Name used in the rule list and generated events.',
  ruleEnabled: 'Enable or disable this rule without deleting it.',
  ruleClassChoices: 'Only selected object classes are eligible for this rule.',
  ruleRegion: 'Polygon whose boundary or occupancy this rule evaluates.',
  ruleLine1: 'First crossing line; required for a line rule.',
  ruleLine2: 'Optional second line for a multi-line rule.',
  ruleLine3: 'Optional third line for a multi-line rule.',
  triggerMode: 'Any emits on a tagged line; Sequence emits only after lines are crossed in order.',
  ruleDirection: 'Enter, Leave, or Both; Both emits once after the same track enters and leaves.',
  headingEnabled: 'Require the track heading to fall within the configured angle range.',
  headingTool: 'Adjust the allowed heading direction on the map.',
  headingCenter: 'Compass direction at the center of the allowed heading range.',
  headingDeviation: 'Allowed angle on either side of the heading center.',
  minSpeed: 'Minimum estimated track speed required to trigger this rule.',
  minAge: 'Minimum time the object must have been tracked before the rule can trigger.',
  debounce: 'Minimum time between events from this rule for the same track.',
  occupancyInterval: 'Maximum time between occupancy count publications, even if the count stays the same.',
};
const editorHelpTooltip = document.createElement('div');
editorHelpTooltip.className = 'editorHelpTooltip';
editorHelpTooltip.id = 'editorHelpTooltip';
editorHelpTooltip.setAttribute('role', 'tooltip');
editorHelpTooltip.hidden = true;
document.body.append(editorHelpTooltip);
function showEditorHelp(icon) {
  editorHelpTooltip.textContent = icon.dataset.tip;
  editorHelpTooltip.hidden = false;
  const bounds = icon.getBoundingClientRect();
  const width = editorHelpTooltip.offsetWidth;
  const height = editorHelpTooltip.offsetHeight;
  editorHelpTooltip.style.left = `${Math.max(10, Math.min(bounds.left, window.innerWidth - width - 10))}px`;
  editorHelpTooltip.style.top = `${bounds.bottom + height + 8 < window.innerHeight ? bounds.bottom + 8 : bounds.top - height - 8}px`;
}
function hideEditorHelp() { editorHelpTooltip.hidden = true; }
document.addEventListener('scroll', hideEditorHelp, true);
for (const [id, description] of Object.entries(editorTooltips)) {
  const control = $(id);
  const label = control.closest('label');
  const icon = document.createElement('span');
  icon.className = 'fieldInfo';
  icon.textContent = 'i';
  icon.tabIndex = 0;
  icon.setAttribute('role', 'note');
  icon.setAttribute('aria-label', description);
  icon.setAttribute('aria-describedby', editorHelpTooltip.id);
  icon.dataset.tip = description;
  icon.onmouseenter = icon.onfocus = () => showEditorHelp(icon);
  icon.onmouseleave = icon.onblur = hideEditorHelp;
  icon.onclick = event => { event.preventDefault(); event.stopPropagation(); icon.focus(); };
  if (label && (id === 'ruleEnabled' || id === 'headingEnabled')) label.append(icon);
  else if (label) label.insertBefore(icon, control);
  else control.after(icon);
}
$('headingTool').parentElement.classList.add('headingToolRow');

function openEditorModal(kind, id) {
  editorModalFocus[kind] = document.activeElement;
  if (kind === 'rule' && state.mode === 'heading' && state.selectedRule !== id) mode('selectTool');
  const modal = kind === 'geometry' ? geometryEditModal : ruleEditModal;
  modal.positionBox(0, 0);
  if (kind === 'geometry') {
    state.selectedRegion = id;
    state.geometryEditorOpen = true;
  } else {
    state.selectedRule = id;
    state.ruleEditorOpen = true;
  }
  renderFields();
  $(kind === 'geometry' ? 'geometryName' : 'ruleName').focus();
}

function closeEditorModal(kind) {
  hideEditorHelp();
  if (kind === 'geometry') state.geometryEditorOpen = false;
  else {
    state.ruleEditorOpen = false;
    if (state.mode === 'heading') mode('selectTool');
  }
  renderFields();
  const target = editorModalFocus[kind];
  (target?.isConnected ? target : $(kind === 'geometry' ? 'newGeometry' : 'addRule')).focus();
}
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!geometryEditModal.hidden) closeEditorModal('geometry');
  else if (!ruleEditModal.hidden) closeEditorModal('rule');
});

function regionAssigned(id) {
  return state.config.rules.some(rule => rule.enabled && (rule.region_id === id || rule.line_region_ids?.includes(id)));
}

function geometryAppearance(region) {
  if (region.type === 'polygon') return 'polygon';
  return /\b(exit|outgoing|outbound|leaving|departure)\b/i.test(region.name) ? 'exit' : 'entry';
}

function geometryPictogram(kind) {
  if (kind === 'polygon') {
    return '<svg viewBox="0 0 48 48" aria-hidden="true"><path class="shapeFill" d="M11 14 32 8 40 35 8 36Z"/><path d="M11 14 32 8 40 35 8 36Z"/><circle cx="11" cy="14" r="2.8"/><circle cx="32" cy="8" r="2.8"/><circle cx="40" cy="35" r="2.8"/><circle cx="8" cy="36" r="2.8"/></svg>';
  }
  return '<svg viewBox="0 0 48 48" aria-hidden="true"><path class="crossingMarks" d="M4 42h7m7 0h7m7 0h7"/><circle class="walker" cx="25" cy="8" r="3"/><path class="walker" d="m23 14-6 3-3 10m9-13 5 5 6 2m-11-6-3 12-7 9m7-9 8 7"/></svg>';
}

function geometryIcon(region, count = 1) {
  const kind = region ? geometryAppearance(region) : 'unassigned';
  const icon = document.createElement('span');
  icon.className = `geometryTypeIcon ${kind}`;
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = region ? geometryPictogram(kind) : editorIcon('layers');
  if (count > 1) {
    const badge = document.createElement('span');
    badge.className = 'geometryIconCount';
    badge.textContent = count;
    icon.append(badge);
  }
  return icon;
}

renderGeometryList = function () {
  if (!state.config) return;
  const root = $('geometryList');
  root.replaceChildren();
  for (const region of state.config.regions) {
    const row = document.createElement('div');
    row.className = 'kyraRow geometryRow' + (state.selectedRegion === region.id ? ' active' : '');
    const name = document.createElement('button');
    name.className = 'geometryName';
    name.textContent = region.name;
    name.onclick = () => {
      state.selectedRegion = state.selectedRegion === region.id ? null : region.id;
      state.geometryEditorOpen = false;
      if (state.selectedRegion) mode('selectTool');
      renderFields();
    };
    const chip = document.createElement('span');
    chip.className = `geometryTypeChip ${geometryAppearance(region)}`;
    chip.innerHTML = region.type === 'line'
      ? '<span class="lineMark" aria-hidden="true"></span><span>Line</span>'
      : '<span class="polygonMark" aria-hidden="true"></span><span>Polygon</span>';
    row.append(geometryIcon(region), name, chip,
      iconButton('edit', 'Edit geometry', () => {
        mode('selectTool');
        openEditorModal('geometry', region.id);
      }),
      iconButton('delete', 'Delete geometry', () => removeGeometry(region.id), true));
    root.append(row);
  }
  const region = selectedRegion();
  const editorOpen = !!region && state.geometryEditorOpen;
  geometryEditModal.hidden = !editorOpen;
  $('geometryEdit').hidden = !editorOpen;
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
  toleranceInput.value = region.boundary_tolerance_m ?? 0;
  toleranceLabel.hidden = region.type !== 'polygon';
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
    ['leaving', 'Leave'], ['both', 'Both (Enter then Leave)']] : [['any', 'Any']];
  select.replaceChildren(...choices.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  const current = rule.type === 'zone_transition' ? rule.direction_mode || 'any' : 'any';
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
  for (const rule of state.config.rules) {
    const row = document.createElement('div');
    row.className = 'kyraRow ruleRow' + (state.selectedRule === rule.id ? ' active' : '');
    const regionIds = rule.type === 'line_crossing'
      ? (rule.line_region_ids?.length ? rule.line_region_ids : [rule.region_id]).filter(Boolean)
      : [rule.region_id].filter(Boolean);
    const linkedRegion = state.config.regions.find(region => region.id === regionIds[0]);
    const typeIcon = geometryIcon(linkedRegion, regionIds.length);
    const toggle = switchControl(rule.enabled !== false, `${rule.enabled !== false ? 'Disable' : 'Enable'} ${rule.name}`, enabled => {
      rule.enabled = enabled;
      dirty();
      renderFields();
    });
    const identity = document.createElement('div');
    identity.className = 'ruleIdentity';
    const name = document.createElement('button');
    name.className = 'ruleName';
    name.textContent = rule.name;
    name.onclick = () => {
      state.selectedRule = state.selectedRule === rule.id ? null : rule.id;
      state.ruleEditorOpen = false;
      renderFields();
    };
    const chip = document.createElement('span');
    chip.className = 'typeChip';
    chip.textContent = rule.type.replace('_', ' ');
    identity.append(name, chip);
    const dividerBefore = document.createElement('span');
    dividerBefore.className = 'ruleDivider';
    dividerBefore.setAttribute('aria-hidden', 'true');
    const edit = iconButton('edit', 'Edit rule', () => {
        openEditorModal('rule', rule.id);
      });
    const remove = iconButton('delete', 'Delete rule', () => removeRule(rule.id), true);
    row.dataset.ruleId = rule.id;
    row.append(typeIcon, identity, dividerBefore, toggle, edit, remove);
    root.append(row);
  }
  updateRuleAlerts();
  const rule = selectedRule();
  const editorOpen = !!rule && state.ruleEditorOpen;
  ruleEditModal.hidden = !editorOpen;
  ruleEditModal.classList.toggle('headingActive', editorOpen && state.mode === 'heading');
  $('ruleEdit').hidden = !editorOpen;
  if (!rule) return;
  $('ruleName').value = rule.name;
  $('ruleType').value = rule.type;
  $('ruleEnabled').checked = rule.enabled !== false;
  $('ruleEnabled').closest('.toggleControl').querySelector('.toggleText').textContent = rule.enabled !== false ? 'Enabled' : 'Disabled';
  $('ruleClasses').value = (rule.class_filter || []).join(',');
  renderClassChoices(rule);
  $('ruleRegionLabel').hidden = rule.type === 'line_crossing';
  $('sequenceFields').hidden = rule.type !== 'line_crossing';
  $('occupancyLabel').hidden = rule.type !== 'occupancy';
  $('ruleDirection').closest('label').hidden = rule.type !== 'zone_transition';
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
  for (const id of ['headingEnabled', 'minSpeed', 'minAge', 'debounce']) {
    $(id).closest('label').hidden = !trackFiltersVisible;
  }
  for (const id of ['headingCenter', 'headingDeviation']) {
    $(id).closest('label').hidden = !trackFiltersVisible || !rule.heading_enabled;
  }
  $('headingTool').parentElement.hidden = !trackFiltersVisible || !rule.heading_enabled;
  $('headingTool').disabled = !trackFiltersVisible || !rule.heading_enabled;
  $('headingTool').classList.toggle('active', state.mode === 'heading' && trackFiltersVisible);
  $('headingTool').textContent = state.mode === 'heading' ? 'Done Adjusting' : 'Adjust Heading';
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
    Object.assign(rule, {heading_enabled: false, heading_center_deg: 0,
      heading_deviation_deg: 45, min_speed_mps: 0,
      min_track_age_ms: type === 'line_crossing' ? 0 : 300,
      debounce_ms: type === 'line_crossing' ? 1500 : 2000});
    if (type === 'zone_transition') rule.direction_mode = 'any';
  } else {
    rule.publish_interval_ms = 500;
  }
  state.config.rules.push(rule);
  state.selectedRule = rule.id;
  dirty();
  openEditorModal('rule', rule.id);
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
  if (rule.type === 'occupancy' && state.mode === 'heading') mode('selectTool');
  const lineOnly = ['line_region_ids', 'line_trigger_mode'];
  const trackOnly = ['direction_mode', 'heading_enabled', 'heading_center_deg',
    'heading_deviation_deg', 'heading_anchor', 'min_speed_mps', 'min_track_age_ms', 'debounce_ms'];
  if (rule.type !== 'line_crossing') for (const key of lineOnly) delete rule[key];
  if (rule.type !== 'occupancy') {
    delete rule.publish_interval_ms;
    if (rule.type === 'zone_transition') rule.direction_mode ??= 'any';
    else delete rule.direction_mode;
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
  const allowed = ['any', 'entering', 'leaving', 'both'];
  if (rule.type === 'zone_transition' && !allowed.includes(rule.direction_mode)) rule.direction_mode = 'any';
  dirty();
  renderFields();
});
for (const [id, key] of [['headingEnabled', 'heading_enabled'], ['headingCenter', 'heading_center_deg'],
  ['headingDeviation', 'heading_deviation_deg']]) {
  $(id).onchange = () => {
    const rule = selectedRule();
    if (!rule) return;
    rule[key] = id === 'headingEnabled' ? $(id).checked : Number($(id).value);
    if (id === 'headingEnabled' && !rule.heading_enabled && state.mode === 'heading') mode('selectTool');
    dirty();
    renderFields();
  };
}

$('headingTool').onclick = () => {
  if (!selectedRule()?.heading_enabled || selectedRule()?.type === 'occupancy') return;
  const headingMode = state.mode !== 'heading';
  mode(headingMode ? 'heading' : 'selectTool');
  renderFields();
  if (headingMode) {
    const box = ruleEditModal.querySelector('.editorModalBox');
    const room = (window.innerWidth - box.offsetWidth) / 2 - 12;
    ruleEditModal.positionBox(Math.min(room, 260), 0);
  }
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

$('newGeometry').onclick = () => {
  if (!state.config) return message('Select a LiDAR agent first');
  state.redrawingRegion = null;
  mode('selectTool');
  $('geometryModal').hidden = false;
};
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
      type: 'polygon', points, boundary_tolerance_m: 0};
  }
  if (region && !validReplacement) {
    state.config.regions.push(region);
    dirty();
  }
  if (region) {
    state.selectedRegion = region.id;
    state.geometryEditorOpen = false;
  }
  state.draft = [];
  state.redrawingRegion = null;
  mode('selectTool');
  if (region) {
    setTab('scene');
    openEditorModal('geometry', region.id);
  }
  else renderFields();
};

setTab = function (tab) {
  if (tab !== 'rules' && state.mode === 'heading') closeEditorModal('rule');
  kyraSetTab(tab);
  if (tab === 'scene') {
    $('scenePanel').hidden = true;
    $('geometryPanel').hidden = false;
  }
};

mode = function (name) {
  if (name !== 'drawLine' && name !== 'drawPolygon') state.redrawingRegion = null;
  state.draftPreview = null;
  kyraMode(name);
  canvas.style.pointerEvents = currentGeo() && name === 'pan' ? 'none' : 'auto';
  canvas.classList.toggle('editing', name === 'selectTool');
  $('selectTool').classList.toggle('active', name === 'selectTool');
  ruleEditModal.classList.toggle('headingActive', name === 'heading' && state.ruleEditorOpen);
  $('headingTool').classList.toggle('active', name === 'heading');
  $('headingTool').textContent = name === 'heading' ? 'Done Adjusting' : 'Adjust Heading';
  renderDrawActions();
};
$('selectTool').onclick = () => mode('selectTool');

renderCanvas = function () {
  kyraCanvasRender();
  if ((state.mode === 'drawLine' || state.mode === 'drawPolygon') && state.draft.length) {
    const ratio = devicePixelRatio || 1;
    if (state.draftPreview) {
      const from = screen(state.draft[state.draft.length - 1]);
      const to = screen(state.draftPreview);
      ctx.save();
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 2 * ratio;
      ctx.setLineDash([6 * ratio, 5 * ratio]);
      ctx.beginPath(); ctx.moveTo(...from); ctx.lineTo(...to); ctx.stroke();
      ctx.restore();
    }
    state.draft.forEach((point, index) => {
      const pixel = screen(point);
      ctx.beginPath();
      ctx.arc(pixel[0], pixel[1], 6 * ratio, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd54f';
      ctx.fill();
      ctx.lineWidth = 2 * ratio;
      ctx.strokeStyle = '#07112d';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `${11 * ratio}px Segoe UI, Arial, sans-serif`;
      ctx.fillText(String(index + 1), pixel[0] + 9 * ratio, pixel[1] - 9 * ratio);
    });
  }
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
canvas.addEventListener('pointermove', event => {
  if (state.mode !== 'drawLine' && state.mode !== 'drawPolygon') return;
  state.draftPreview = world(pointer(event));
  if (state.draft.length) renderCanvas();
});
canvas.addEventListener('pointerleave', () => {
  if (!state.draftPreview) return;
  state.draftPreview = null;
  if (state.draft.length) renderCanvas();
});

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
        state.geometryEditorOpen = false;
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
