import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../dist/version.js';

test('same minor, different patch: fine', () => {
    assert.equal(compareVersions('3.4.9', '3.4.4', '1').warning, undefined);
});
test('unknown panel version: no warning', () => {
    assert.equal(compareVersions(undefined, '3.4.4', '1').warning, undefined);
});
test('older minor → download matching build', () => {
    assert.match(compareVersions('3.3.3', '3.4.4', '1').warning, /remnawave-3\.3\.mcpb/);
});
test('newer major → update', () => {
    assert.match(compareVersions('4.0.1', '3.4.4', '1').warning, /Update remnawave-mcp/);
});
