import test from 'node:test';
import assert from 'node:assert/strict';
import { render, compact } from '../dist/format.js';

test('compact drops nulls and duplicated rawInbound', () => {
    assert.deepEqual(compact({ a: 1, b: null, inbounds: [{ tag: 'x', rawInbound: { big: true } }] }), { a: 1, inbounds: [{ tag: 'x' }] });
});

test('compact output is much shorter than pretty JSON', () => {
    const data = { users: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `u${i}`, note: null, nested: { a: 1, b: null } })) };
    const pretty = render(data, { max: 1e9, compact: false });
    const small = render(data, { max: 1e9, compact: true });
    assert.ok(small.length < pretty.length * 0.7, `${small.length} vs ${pretty.length}`);
});

test('long lists are shortened with a note instead of cutting JSON', () => {
    const data = { total: 1000, users: Array.from({ length: 1000 }, (_, i) => ({ id: i, username: `user-${i}` })) };
    const text = render(data, { max: 5000, compact: true });
    assert.ok(text.length <= 5200);
    assert.match(text, /^\[shortened to fit: \$\.users: shown \d+ of 1000/);
    const json = JSON.parse(text.slice(text.indexOf('\n') + 1));
    assert.equal(json.total, 1000);
    assert.ok(json.users.length > 1 && json.users.length < 1000);
});
