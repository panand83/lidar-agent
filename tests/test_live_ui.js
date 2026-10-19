const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');
const start = source.indexOf('function trackIdentity(');
const end = source.indexOf('async function refresh()', start);
assert.ok(start >= 0 && end > start);
const state = {snapshot: null, live: null, liveEvents: [], eventCursor: null,
  alertSeen: null, ruleAlertUntil: new Map(), geometryAlertUntil: new Map(),
  config: {rules: [{id: 'rule', line_region_ids: ['line-a', 'line-b']},
    {id: 'zone-rule', region_id: 'zone-a'},
    {id: 'count-rule', region_id: 'zone-a'}]}};
const row = {dataset: {ruleId: 'rule'}, classList: {toggle: () => {}}};
const context = {state, document: {querySelectorAll: () => [row]}};
const alertStart = source.indexOf('function eventGeometryIds(');
assert.ok(alertStart >= 0 && alertStart < start);
vm.runInNewContext(source.slice(alertStart, start), context);
vm.runInNewContext(source.slice(start, end), context);
assert.deepEqual(Array.from(context.eventGeometryIds({rule_id: 'rule', line_region_id: 'line-b',
  line_region_ids: ['line-b']})), ['line-b']);

const older = {event_id: 'older', rule_id: 'rule', timestamp: 100};
const newer = {event_id: 'newer', rule_id: 'rule', timestamp: 101,
  line_region_id: 'line-b', line_region_ids: ['line-a', 'line-b']};
const track = {id: '7', sensor: '1', frame: 'frame', class: 'car', x: 1, y: 2, time: 100, points: [[1, 2]]};
const full = () => ({status: {last_received: 100, last_message: 100, tracks: 1},
  tracks: [{...track, points: [...track.points]}], events: [older], occupancy_events: []});

context.applyFullSnapshot(full());
assert.equal(state.eventCursor, 'older');
context.updateRuleAlerts();
context.applyLiveSnapshot({status: {last_received: 101, last_message: 101, tracks: 1},
  tracks: [{...track, x: 3, y: 4, time: 101}], events: [newer]});
context.updateRuleAlerts();
assert.ok(state.ruleAlertUntil.get('rule') > Date.now());
assert.equal(state.geometryAlertUntil.get('line-a'), state.ruleAlertUntil.get('rule'));
assert.equal(state.geometryAlertUntil.get('line-b'), state.ruleAlertUntil.get('rule'));
assert.equal(state.snapshot.tracks[0].x, 3);
assert.equal(state.snapshot.tracks[0].points.length, 2);
assert.equal(state.snapshot.events[0].event_id, 'newer');
assert.equal(state.eventCursor, 'newer');
const occupancy = {event_id: 'count-1', rule_id: 'count-rule', region_id: 'zone-a',
  event_type: 'occupancy', count: 2, timestamp: 101};
assert.equal(context.applyLiveSnapshot({status: {last_received: 101, last_message: 101, tracks: 1},
  tracks: [{...track, x: 3, y: 4, time: 101}], events: [], occupancy_events: [occupancy]}), true);
assert.equal(state.snapshot.occupancy_events[0].count, 2);
context.updateRuleAlerts();
assert.ok(state.ruleAlertUntil.get('count-rule') > Date.now());
assert.equal(context.applyLiveSnapshot({status: {last_received: 101, last_message: 101, tracks: 1},
  tracks: [{...track, x: 3, y: 4, time: 101}], events: [], occupancy_events: [occupancy]}), false);

context.applyFullSnapshot(full());
assert.equal(state.snapshot.tracks[0].x, 3);
assert.equal(state.snapshot.events[0].event_id, 'newer');
assert.equal(state.snapshot.events.length, 2);
assert.equal(state.snapshot.occupancy_events[0].event_id, 'count-1');
state.snapshot.events.unshift({event_id: 'zone-event', rule_id: 'zone-rule', region_id: 'zone-a', timestamp: 1});
context.updateRuleAlerts();
assert.equal(state.geometryAlertUntil.get('zone-a'), state.ruleAlertUntil.get('zone-rule'));
console.log('Live map and event merge passed');
