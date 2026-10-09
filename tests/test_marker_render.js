const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');
const start = source.indexOf('const markerSvgs =');
const end = source.indexOf('function message(', start);
assert.ok(start >= 0 && end > start);

const calls = [];
const ctx = Object.fromEntries(['save', 'restore', 'translate', 'rotate', 'drawImage', 'beginPath', 'arc', 'fill']
  .map(method => [method, (...args) => calls.push([method, ...args])]));
class TestImage {
  constructor() { this.complete = true; this.naturalWidth = 12; }
  addEventListener() {}
  set src(value) { this.url = value; }
}
const context = vm.createContext({Image: TestImage, ctx, devicePixelRatio: 1,
  state: {id: 'lidar-1', config: {map_alignment: {geo: {scale: 1}}}},
  screen: point => [point[0], -point[1]]});
vm.runInContext(source.slice(start, end), context);
assert.equal(vm.runInContext('markerSvgs.car.includes("#1677FF")', context), true);
assert.equal(vm.runInContext('markerSvgs.human.includes("Red walking person top view")', context), true);

const draw = track => {
  calls.length = 0;
  context.track = track;
  vm.runInContext('drawTrackMarker(track, [track.x, -track.y])', context);
  return [...calls];
};
const car = {id: '7', frame: 'frame', sensor: '1', class: 'car', x: 1, y: 0,
  points: [[0, 0], [1, 0]]};
const carCalls = draw(car);
assert.ok(Math.abs(carCalls.find(call => call[0] === 'rotate')[1] - Math.PI / 2) < 1e-6);
assert.deepEqual(carCalls.find(call => call[0] === 'drawImage').slice(2), [-10, -10, 20, 20]);
assert.ok(Math.abs(draw({...car, points: [[1, 0], [1, 0]]}).find(call => call[0] === 'rotate')[1] - Math.PI / 2) < 1e-6);

const humanCalls = draw({...car, class: 'human'});
assert.ok(Math.abs(humanCalls.find(call => call[0] === 'rotate')[1] - Math.PI / 2) < 1e-6);
assert.deepEqual(humanCalls.find(call => call[0] === 'drawImage').slice(2), [-10, -10, 20, 20]);
const northboundHuman = draw({...car, class: 'person', x: 0, y: 1, points: [[0, 0], [0, 1]]});
assert.ok(Math.abs(northboundHuman.find(call => call[0] === 'rotate')[1]) < 1e-6);
const westboundHuman = draw({...car, class: 'human', x: -1, y: 0, points: [[0, 0], [-1, 0]]});
assert.ok(Math.abs(westboundHuman.find(call => call[0] === 'rotate')[1] - 3 * Math.PI / 2) < 1e-6);
assert.ok(draw({...car, class: 'other'}).some(call => call[0] === 'arc'));
assert.equal(ctx.fillStyle, '#4b5563');
console.log('Map marker size and heading passed');
