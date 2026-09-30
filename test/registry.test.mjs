import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistry, toolName } from '../dist/registry.js';

test('tool names are unique snake_case', () => {
    const tools = buildRegistry();
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.every((n) => /^[a-z0-9_]+$/.test(n)));
    assert.equal(toolName('GetUserByIdCommand'), 'get_user_by_id');
});

test('every tool has a JSON input schema and a known method', () => {
    for (const t of buildRegistry()) {
        assert.equal(t.inputSchema.type, 'object', t.name);
        assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(t.method), t.name);
    }
});
