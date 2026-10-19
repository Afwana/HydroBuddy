const assert = require('assert');
const { nextAfter, inWork } = require('../lib/schedule');
const S = { interval: 45, workStart: '09:00', workEnd: '18:00', scheduleMode: 'relative' };
const at = (h, m = 0, d = 10) => new Date(2026, 0, d, h, m).getTime();
assert.strictEqual(nextAfter(at(9), S), at(9, 45));            // first reminder 9:45
assert.strictEqual(nextAfter(at(8), S), at(9, 45));            // before work -> 9:45
assert.strictEqual(nextAfter(at(17, 30), S), at(9, 45, 11));   // past end -> tomorrow 9:45
assert.strictEqual(nextAfter(at(10, 10), { ...S, scheduleMode: 'fixed' }), at(10, 30)); // clock slots 9:45, 10:30...
assert.ok(inWork(at(12), S) && !inWork(at(19), S));
console.log('schedule tests passed');
