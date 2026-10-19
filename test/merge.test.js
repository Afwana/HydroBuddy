const assert = require('assert');
const { mergeLogs, mergeEvents } = require('../lib/merge');
const L = (id, amount, updatedAt, deleted = false) => ({ id, ts: 1, amount, source: 'x', deleted, updatedAt });
let local = [{ ...L('a', 250, 100), dirty: true }];
assert.strictEqual(mergeLogs(local, [L('b', 500, 50)]), 1);                       // new remote record added
assert.strictEqual(local.length, 2);
assert.strictEqual(mergeLogs(local, [L('a', 100, 90)]), 0);                       // older remote ignored
assert.strictEqual(local[0].amount, 250);
assert.strictEqual(mergeLogs(local, [L('a', 300, 200)]), 1);                      // newer remote wins
assert.ok(local[0].amount === 300 && local[0].dirty === false);
mergeLogs(local, [L('b', 500, 300, true)]);                                       // tombstone propagates
assert.ok(local.find(l => l.id === 'b').deleted);
mergeLogs(local, [L('b', 500, 300, true)]);                                       // idempotent
assert.strictEqual(local.length, 2);
const ev = [{ id: 'e1', ts: 1, outcome: 'drink' }];
assert.strictEqual(mergeEvents(ev, [{ id: 'e1', ts: 1, outcome: 'drink' }, { id: 'e2', ts: 2, outcome: 'snooze' }]), 1);
console.log('merge tests passed');
