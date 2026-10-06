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

test('a top-level list (get_nodes, get_hosts) is shortened as a whole, small inner lists are left alone', () => {
    const data = Array.from({ length: 50 }, (_, i) => ({ uuid: `h${i}`, remark: `host ${i}`, tags: ['a', 'b'], pad: 'x'.repeat(40) }));
    const text = render(data, { max: 1500, compact: true });
    assert.match(text, /^\[shortened to fit: \$: shown \d+ of 50/);
    assert.ok(!/tags: shown/.test(text), text.slice(0, 300));
    const json = JSON.parse(text.slice(text.indexOf('\n') + 1));
    assert.ok(Array.isArray(json) && json.length < 50 && json.every((h) => h.tags.length === 2));
});

test('max 0 means no limit', () => {
    const data = { users: Array.from({ length: 500 }, (_, i) => ({ id: i })) };
    assert.equal(render(data, { max: 0, compact: true }), JSON.stringify(data));
});
