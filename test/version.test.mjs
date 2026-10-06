import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, runtimeFromEnv } from '../dist/version.js';

test('same minor, different patch: fine', () => {
    assert.equal(compareVersions('3.4.9', '3.4.4', '1').warning, undefined);
});
test('unknown panel version: no warning', () => {
    assert.equal(compareVersions(undefined, '3.4.4', '1').warning, undefined);
});
test('older minor → download matching build', () => {
    assert.match(compareVersions('3.3.3', '3.4.4', '1', 'mcpb').warning, /remnawave-3\.3\.mcpb/);
});
test('docker: hint points to the image tag of the panel version', () => {
    const w = compareVersions('3.3.3', '3.4.4', '1', 'docker').warning;
    assert.match(w, /docker pull ghcr\.io\/3apa3a-3aho3a\/remnawave-mcp:3\.3/);
    assert.doesNotMatch(w, /\.mcpb|npm i/);
});
test('manual install: hint is the npm command for the exact panel version', () => {
    const w = compareVersions('3.3.3', '3.4.4', '1', 'node').warning;
    assert.match(w, /npm i @remnawave\/backend-contract@3\.3\.3 --save-exact/);
    assert.doesNotMatch(w, /\.mcpb|docker pull/);
});
test('runtime comes from REMNAWAVE_RUNTIME, unknown values mean a manual install', () => {
    assert.equal(runtimeFromEnv('docker'), 'docker');
    assert.equal(runtimeFromEnv('MCPB'), 'mcpb');
    assert.equal(runtimeFromEnv(''), 'node');
    assert.equal(runtimeFromEnv('whatever'), 'node');
});
test('newer major → update', () => {
    assert.match(compareVersions('4.0.1', '3.4.4', '1', 'mcpb').warning, /newer remnawave-mcp release/);
});
