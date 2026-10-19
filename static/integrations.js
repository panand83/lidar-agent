/* Per-LiDAR alert mappings; the detection rule remains unchanged. */
const integrationRenderFields = renderFields;
let integrationCatalogSignature = '';

function integrationConfig() {
  return state.config?.integrations;
}

function fillIntegrationSelect(select, options, value) {
  select.replaceChildren();
  for (const [key, label] of options) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = label;
    select.append(option);
  }
  if (value && !options.some(([key]) => key === value)) {
    const missing = document.createElement('option');
    missing.value = value;
    missing.textContent = `${value} (not available)`;
    select.append(missing);
  }
  select.value = value || '';
}

const integrationModal = document.createElement('div');
integrationModal.className = 'modalBackdrop';
integrationModal.id = 'integrationModal';
integrationModal.hidden = true;
integrationModal.innerHTML = `<form class="modalBox integrationModalBox" id="integrationForm" role="dialog" aria-modal="true" aria-labelledby="integrationModalTitle">
  <h2 id="integrationModalTitle">Alert mapping</h2>
  <label>Use case<select id="integrationUseCase"><option value="wrongway_vehicle">Wrong-way vehicle</option></select></label>
  <label>Zone type<select id="integrationZone"><option value="1">Detection Zone</option><option value="3">Confirmation Zone</option></select></label>
  <fieldset class="integrationRuleField"><legend>LiDAR rules (any)</legend><div id="integrationLocalRules" class="integrationRuleChoices"></div></fieldset>
  <label>External rule<select id="integrationExternalRule" required></select></label>
  <label title="Suppresses new subalerts and warning-device actions for this mapping across all selected LiDAR rules. Source events are unaffected.">Subalert debounce (s)<input id="integrationDebounce" type="number" min="0" max="3600" step="0.1" value="0" required></label>
  <label class="toggleControl"><input id="integrationEnabled" type="checkbox"><span class="toggleTrack" aria-hidden="true"></span><span class="toggleText">Disabled</span></label>
  <div class="row"><button type="button" id="cancelIntegration">Cancel</button><button type="submit" class="primary" id="confirmIntegration">Add mapping</button></div>
</form>`;
document.body.append(integrationModal);
let editingIntegrationId = null;
let integrationModalLidarId = null;
let integrationModalFocus = null;

function closeIntegrationModal() {
  integrationModal.hidden = true;
  editingIntegrationId = null;
  integrationModalLidarId = null;
  integrationModalFocus?.focus();
}

function integrationRuleIds(mapping) {
  return mapping?.rule_ids ?? (mapping?.rule_id ? [mapping.rule_id] : []);
}

function renderIntegrationRuleChoices(mapping) {
  const selected = new Set(integrationRuleIds(mapping));
  const choices = $('integrationLocalRules');
  choices.replaceChildren();
  const local = (state.config.rules || []).filter(rule => ['line_crossing', 'zone_transition'].includes(rule.type));
  for (const rule of local) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = rule.id;
    input.checked = selected.has(rule.id);
    label.append(input, document.createTextNode(rule.name));
    choices.append(label);
  }
  for (const missing of selected) {
    if (local.some(rule => rule.id === missing)) continue;
    const label = document.createElement('label');
    label.textContent = `Missing rule (${missing})`;
    choices.append(label);
  }
}

function openIntegrationModal(mapping = null) {
  if (!state.config) return;
  editingIntegrationId = mapping?.id || null;
  integrationModalLidarId = state.id;
  integrationModalFocus = document.activeElement;
  $('integrationModalTitle').textContent = mapping ? 'Edit alert mapping' : 'Add alert mapping';
  $('confirmIntegration').textContent = mapping ? 'Update mapping' : 'Add mapping';
  $('integrationUseCase').value = mapping?.use_case || 'wrongway_vehicle';
  $('integrationZone').value = String(mapping?.zone || 1);
  $('integrationEnabled').checked = mapping?.enabled === true;
  $('integrationEnabled').closest('.toggleControl').querySelector('.toggleText').textContent = mapping?.enabled === true ? 'Enabled' : 'Disabled';
  $('integrationEnabled').onchange = () => {
    $('integrationEnabled').closest('.toggleControl').querySelector('.toggleText').textContent = $('integrationEnabled').checked ? 'Enabled' : 'Disabled';
  };
  $('integrationDebounce').value = mapping?.debounce_sec ?? 0;
  const external = Object.values(state.snapshot?.integration_catalog?.rules || {})
    .map(rule => [rule.id, rule.name || rule.id]);
  renderIntegrationRuleChoices(mapping);
  fillIntegrationSelect($('integrationExternalRule'), [['', 'Select external rule'], ...external], mapping?.external_rule_id);
  integrationModal.hidden = false;
  $('integrationLocalRules').querySelector('input')?.focus();
}

$('cancelIntegration').onclick = closeIntegrationModal;
integrationModal.onclick = event => { if (event.target === integrationModal) closeIntegrationModal(); };
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !integrationModal.hidden) closeIntegrationModal();
});
$('integrationForm').onsubmit = event => {
  event.preventDefault();
  if (state.id !== integrationModalLidarId) return closeIntegrationModal();
  if ($('integrationEnabled').checked && !state.config.map_alignment?.geo) {
    message('Map alignment is required before enabling an alert mapping');
    return;
  }
  const config = integrationConfig();
  const debounce = Number($('integrationDebounce').value);
  if (!Number.isFinite(debounce) || debounce < 0 || debounce > 3600) {
    message('Subalert debounce must be between 0 and 3600 seconds');
    return;
  }
  const ruleIds = [...$('integrationLocalRules').querySelectorAll('input:checked')].map(input => input.value);
  if (!ruleIds.length) {
    message('Select at least one LiDAR rule');
    return;
  }
  const mapping = config.mappings.find(item => item.id === editingIntegrationId);
  const values = {enabled: $('integrationEnabled').checked, use_case: $('integrationUseCase').value,
    zone: Number($('integrationZone').value), rule_ids: ruleIds,
    external_rule_id: $('integrationExternalRule').value, debounce_sec: debounce};
  if (mapping) {
    Object.assign(mapping, values);
    delete mapping.rule_id;
  }
  else config.mappings.push({id: uid('integration'), ...values});
  closeIntegrationModal();
  dirty();
  renderIntegrationFields();
};

function renderIntegrationFields() {
  const config = integrationConfig();
  if (!config) return;
  if (!integrationModal.hidden && state.id !== integrationModalLidarId) closeIntegrationModal();
  $('mqttEventTopic').value = 'events';
  $('mqttEventTopic').disabled = true;
  $('subalertTopic').value = config.subalert_topic;
  $('ruleConfigTopic').value = config.rule_topic;
  $('rseConfigTopic').value = config.rse_topic;
  $('illuminatorInterval').value = config.illuminator_interval_sec || 5;
  const catalog = state.snapshot?.integration_catalog || {};
  const rules = catalog.rules || {};
  const devices = catalog.devices || {};
  const status = catalog.status || {};
  const receipt = kind => status[`${kind}_refresh_pending`] ? `${kind.toUpperCase()}: waiting for broadcast` :
    status[`${kind}_received_at`] ? `${kind.toUpperCase()}: received ${new Date(status[`${kind}_received_at`]).toLocaleString()}` :
      `${kind.toUpperCase()}: waiting for first broadcast`;
  $('integrationStatus').textContent = `${Object.keys(rules).length} external rules, ${Object.keys(devices).length} devices | ${receipt('rule')} | ${receipt('rse')}${status.last_subalert ? ` | last subalert ${status.last_subalert}` : ''}${status.subalerts_debounced ? ` | ${status.subalerts_debounced} debounced` : ''}${status.error ? ` | ${status.error}` : ''}`;
  const root = $('integrationList');
  root.replaceChildren();
  if (!config.mappings?.length) {
    const empty = document.createElement('p');
    empty.className = 'integrationDetail';
    empty.textContent = 'No alert mappings';
    root.append(empty);
  }
  for (const mapping of config.mappings || []) {
    const row = document.createElement('div');
    row.className = 'integrationRow';
    const heading = document.createElement('div');
    heading.className = 'panelHeading';
    const identity = document.createElement('div');
    identity.className = 'integrationIdentity';
    const title = document.createElement('strong');
    title.textContent = integrationMappingTitle(mapping.zone);
    const stateLabel = document.createElement('span');
    stateLabel.className = `integrationState ${mapping.enabled ? 'isEnabled' : 'isDisabled'}`;
    stateLabel.textContent = mapping.enabled ? 'Enabled' : 'Disabled';
    identity.append(title, stateLabel);
    const actions = document.createElement('div');
    actions.className = 'integrationActions';
    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.title = 'Edit alert mapping';
    edit.onclick = () => openIntegrationModal(mapping);
    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.title = 'Delete alert mapping';
    remove.onclick = () => {
      config.mappings = config.mappings.filter(item => item.id !== mapping.id);
      dirty();
      renderIntegrationFields();
    };
    actions.append(edit, remove);
    heading.append(identity, actions);
    row.append(heading);
    const localRules = integrationRuleIds(mapping).map(id => (state.config.rules || []).find(rule => rule.id === id)?.name || 'Missing LiDAR rule');
    const external = rules[mapping.external_rule_id];
    const route = document.createElement('div');
    route.className = 'integrationRoute';
    route.textContent = `${localRules.join(' OR ') || 'No LiDAR rules'} -> ${external?.name || 'Missing external rule'} | ${mapping.debounce_sec || 0}s debounce`;
    row.append(route);
    const assigned = (external?.lights || []).filter(light => String(light.zoneId) === String(mapping.zone));
    const deviceIds = assigned.flatMap(light => [light.flasherId, light.illuminatorId].filter(Boolean));
    const ready = deviceIds.filter(id => devices[id]);
    const deviceLabels = deviceIds.map(id => {
      const device = devices[id];
      if (!device) return `Unavailable device (${id})`;
      const name = device.name || device.type;
      return device.friendly_id ? `${name} (${device.friendly_id})` : name;
    });
    const detail = document.createElement('div');
    detail.className = 'integrationDetail';
    detail.textContent = !state.config.map_alignment?.geo ? 'Map alignment required' :
      !external ? 'Waiting for external rule configuration' :
      deviceIds.length ? `${ready.length}/${deviceIds.length} assigned devices available: ${deviceLabels.join(', ')}` :
        'No warning devices assigned to this zone';
    row.append(detail);
    root.append(row);
  }
}

for (const [field, key] of [['subalertTopic', 'subalert_topic'], ['ruleConfigTopic', 'rule_topic'], ['rseConfigTopic', 'rse_topic']]) {
  $(field).onchange = () => {
    if (!integrationConfig()) return;
    integrationConfig()[key] = $(field).value.trim();
    dirty();
  };
}
$('illuminatorInterval').onchange = () => {
  if (!integrationConfig()) return;
  integrationConfig().illuminator_interval_sec = Number($('illuminatorInterval').value);
  dirty();
};
let importKind = null;
for (const [button, kind] of [['importRuleConfig', 'rule'], ['importRseConfig', 'rse']]) {
  $(button).onclick = () => {
    if (!state.id) return;
    importKind = kind;
    $('integrationConfigFile').value = '';
    $('integrationConfigFile').click();
  };
}
$('integrationConfigFile').onchange = async () => {
  const file = $('integrationConfigFile').files[0];
  const lidarId = state.id;
  const kind = importKind;
  if (!file || !lidarId || !kind) return;
  try {
    const data = JSON.parse(await file.text());
    const response = await api(`/api/lidars/${encodeURIComponent(lidarId)}/integration-config/${kind}`, 'POST', data);
    if (state.id !== lidarId) return;
    state.snapshot.integration_catalog = response.catalog;
    renderIntegrationFields();
    message(`${kind === 'rule' ? 'Rule' : 'RSE'} configuration imported`);
  } catch (error) { message(error.message); }
};
const refreshIntegration = document.createElement('button');
refreshIntegration.textContent = 'Refresh configurations';
refreshIntegration.title = 'Re-subscribe to Rule and RSE configuration topics';
refreshIntegration.onclick = async () => {
  if (!state.id) return;
  const lidarId = state.id;
  refreshIntegration.disabled = true;
  try {
    const response = await api(`/api/lidars/${encodeURIComponent(lidarId)}/integration-refresh`, 'POST', {});
    if (state.id !== lidarId) return;
    state.snapshot.integration_catalog = response.catalog;
    renderIntegrationFields();
    message('Waiting for the next configuration broadcast');
  } catch (error) { message(error.message); }
  finally { refreshIntegration.disabled = false; }
};
$('integrationStatus').before(refreshIntegration);
$('addIntegration').onclick = () => {
  openIntegrationModal();
};

renderFields = function () {
  integrationRenderFields();
  renderIntegrationFields();
};
const integrationRenderStatus = renderStatus;
renderStatus = function () {
  integrationRenderStatus();
  if (state.tab !== 'integrations') return;
  const signature = JSON.stringify(state.snapshot?.integration_catalog || {});
  if (signature !== integrationCatalogSignature) {
    integrationCatalogSignature = signature;
    renderIntegrationFields();
  }
};
