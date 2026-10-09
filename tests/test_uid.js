const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');
const match = source.match(/function uid\(prefix\)\{[\s\S]*?\n\}/);
assert.ok(match, 'LiDAR UI ID generator exists');
const context = {crypto: {getRandomValues: webcrypto.getRandomValues.bind(webcrypto)}};
vm.runInNewContext(match[0], context);
const ids = Array.from({length: 1000}, () => vm.runInNewContext('uid("line")', context));
assert.equal(new Set(ids).size, ids.length);
assert.ok(ids.every(id => /^line-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)));
console.log('Generated 1000 unique UUID v4 IDs without crypto.randomUUID');
